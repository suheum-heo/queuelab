import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Prisma, type PrismaClient } from '@queuelab/database';
import {
  DEFAULT_MAX_ATTEMPTS,
  type CsvAnalysisOptions,
  type CsvAnalysisPayload,
} from '@queuelab/shared-types';
import { Job, UnrecoverableError } from 'bullmq';
import { analyzeCsvFile, permanentCsvError } from './csv/analyze-file';
import type { JobNotifier } from './job-notifier';

const UPLOAD_KEY =
  /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.csv$/i;

/**
 * One BullMQ job is one execution. Automatic retries reuse that execution id.
 * A manual retry enqueues a new execution. This function returns without
 * writing when its execution is no longer the job's current one, so a late
 * attempt cannot replace a newer result.
 *
 * Each attempt reads the CSV from the start. JobResult is upserted on job_id.
 */
export async function processCsvJob(
  prisma: PrismaClient,
  job: Job<CsvAnalysisPayload>,
  storageRoot: string,
  notifier: JobNotifier,
): Promise<void> {
  const payload = job.data;
  if (!payload?.jobId || !payload.executionId) {
    throw new UnrecoverableError('Job payload is missing its job or execution id');
  }

  const record = await prisma.job.findUnique({ where: { id: payload.jobId } });
  if (!record) {
    throw new UnrecoverableError(`Job ${payload.jobId} does not exist`);
  }
  if (record.currentExecutionId !== payload.executionId) {
    return;
  }
  if (record.status === 'COMPLETED') {
    return;
  }
  if (!payload.fileKey || !UPLOAD_KEY.test(payload.fileKey)) {
    throw new UnrecoverableError('Job is missing its uploaded CSV');
  }

  const execution = await prisma.jobExecution.findUnique({ where: { id: payload.executionId } });
  if (!execution || execution.jobId !== record.id) {
    throw new UnrecoverableError('Execution does not belong to this job');
  }

  const root = resolve(storageRoot);
  const source = resolve(root, payload.fileKey);
  if (!source.startsWith(root + sep)) {
    throw new UnrecoverableError('Upload path escapes storage');
  }

  const attempt = job.attemptsMade + 1;
  const claimed = await prisma.job.updateMany({
    where: { id: record.id, currentExecutionId: payload.executionId },
    data: {
      status: 'PROCESSING',
      attempts: attempt,
      progress: 0,
      startedAt: record.startedAt ?? new Date(),
      finishedAt: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) return;

  await prisma.jobExecution.update({
    where: { id: execution.id },
    data: {
      status: 'PROCESSING',
      attempts: attempt,
      startedAt: execution.startedAt ?? new Date(),
      finishedAt: null,
      errorMessage: null,
    },
  });
  await prisma.jobEvent.create({
    data: {
      jobId: record.id,
      eventType: 'PROCESSING',
      message: `Execution ${execution.number}, attempt ${attempt} claimed the file`,
      metadata: {
        attempt,
        executionId: execution.id,
        executionNumber: execution.number,
        fileKey: payload.fileKey,
      },
    },
  });
  await notifier.publish(record.id, 'PROCESSING');

  const demoFailure = demoFailureMessage(payload.options, execution.number, job.attemptsMade);
  if (demoFailure) {
    throw new Error(demoFailure);
  }

  const announced = new Set<number>();
  let analysis;
  try {
    analysis = await analyzeCsvFile(
      source,
      {
        delimiter: payload.options?.delimiter || ',',
        hasHeader: payload.options?.hasHeader ?? true,
      },
      async ({ processedRows, progress }) => {
        if (!(await isCurrent(prisma, record.id, payload.executionId))) {
          throw new UnrecoverableError('Execution is no longer current');
        }
        await prisma.job.updateMany({
          where: { id: record.id, currentExecutionId: payload.executionId },
          data: { progress },
        });
        await job.updateProgress(progress);
        if (progress < 100) {
          await recordMilestone(prisma, record.id, execution, progress, processedRows, announced);
          await notifier.publish(record.id, 'PROGRESS');
        }
      },
    );
  } catch (error) {
    const permanent = permanentCsvError(error);
    if (permanent) throw new UnrecoverableError(permanent.message);
    throw error;
  }

  const temporary = resolve(root, `results/${record.id}.${execution.id}.json.tmp`);
  if (!temporary.startsWith(root + sep)) {
    throw new UnrecoverableError('Refusing to write a report outside storage');
  }
  await mkdir(dirname(temporary), { recursive: true });
  await writeFile(temporary, JSON.stringify(analysis, null, 2));

  const won = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: { id: record.id, currentExecutionId: payload.executionId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        resultKey: `results/${record.id}.json`,
        finishedAt: new Date(),
        errorMessage: null,
      },
    });
    if (updated.count !== 1) return false;

    await tx.jobResult.upsert({
      where: { jobId: record.id },
      create: {
        jobId: record.id,
        executionId: execution.id,
        totalRows: analysis.totalRows,
        validRows: analysis.validRows,
        invalidRows: analysis.invalidRows,
        summary: analysis as unknown as Prisma.InputJsonValue,
      },
      update: {
        executionId: execution.id,
        totalRows: analysis.totalRows,
        validRows: analysis.validRows,
        invalidRows: analysis.invalidRows,
        summary: analysis as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.jobExecution.update({
      where: { id: execution.id },
      data: { status: 'COMPLETED', attempts: attempt, finishedAt: new Date(), errorMessage: null },
    });
    await tx.jobEvent.create({
      data: {
        jobId: record.id,
        eventType: 'COMPLETED',
        message: `Execution ${execution.number} stored the report for ${analysis.totalRows.toLocaleString()} rows (${analysis.invalidRows.toLocaleString()} invalid)`,
        metadata: {
          executionId: execution.id,
          executionNumber: execution.number,
          attempt,
          resultKey: `results/${record.id}.json`,
          totalRows: analysis.totalRows,
          validRows: analysis.validRows,
          invalidRows: analysis.invalidRows,
        },
      },
    });
    return true;
  });

  if (!won) {
    await rm(temporary, { force: true });
    return;
  }

  await rename(temporary, resolve(root, `results/${record.id}.json`));
  await notifier.publish(record.id, 'COMPLETED');
}

export async function markFailed(
  prisma: PrismaClient,
  job: Job<CsvAnalysisPayload>,
  error: Error,
  notifier: JobNotifier,
): Promise<void> {
  const jobId = job.data?.jobId;
  const executionId = job.data?.executionId;
  if (!jobId || !executionId) return;
  if (error.message === 'Execution is no longer current') return;

  const current = await prisma.job.findUnique({ where: { id: jobId } });
  if (!current || current.status === 'COMPLETED') return;
  if (current.currentExecutionId !== executionId) return;

  const execution = await prisma.jobExecution.findUnique({ where: { id: executionId } });
  const maxAttempts = job.opts.attempts ?? DEFAULT_MAX_ATTEMPTS;
  const permanent = error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
  const willRetry = !permanent && job.attemptsMade < maxAttempts;
  const executionNumber = execution?.number ?? current.executionNumber;

  await prisma.job.updateMany({
    where: { id: jobId, currentExecutionId: executionId },
    data: {
      status: willRetry ? 'RETRYING' : 'FAILED',
      attempts: job.attemptsMade,
      errorMessage: error.message,
      finishedAt: willRetry ? null : new Date(),
    },
  });
  await prisma.jobExecution.update({
    where: { id: executionId },
    data: {
      status: willRetry ? 'RETRYING' : 'FAILED',
      attempts: job.attemptsMade,
      errorMessage: error.message,
      finishedAt: willRetry ? null : new Date(),
    },
  });
  await prisma.jobEvent.create({
    data: {
      jobId,
      eventType: willRetry ? 'RETRYING' : 'FAILED',
      message: willRetry
        ? `Execution ${executionNumber}, attempt ${job.attemptsMade} failed and will be retried. ${error.message}`
        : `Execution ${executionNumber} failed after ${job.attemptsMade} attempt${job.attemptsMade === 1 ? '' : 's'}. ${error.message}`,
      metadata: {
        attempt: job.attemptsMade,
        executionId,
        executionNumber,
        willRetry,
      },
    },
  });
  await notifier.publish(jobId, willRetry ? 'RETRYING' : 'FAILED');
}

function demoFailureMessage(
  options: CsvAnalysisOptions | undefined,
  executionNumber: number,
  attemptsMade: number,
): string | null {
  if (options?.demoFailure === 'transient' && attemptsMade === 0) {
    return 'Simulated transient failure on attempt 1. The next attempt processes the file.';
  }
  if (options?.demoFailure === 'exhaust-first-execution' && executionNumber === 1) {
    return 'Simulated failure of execution 1. A manual retry starts a new execution.';
  }
  return null;
}

async function isCurrent(prisma: PrismaClient, jobId: string, executionId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { currentExecutionId: true },
  });
  return job?.currentExecutionId === executionId;
}

async function recordMilestone(
  prisma: PrismaClient,
  jobId: string,
  execution: { id: string; number: number },
  progress: number,
  processedRows: number,
  announced: Set<number>,
): Promise<void> {
  const crossed = [25, 50, 75].filter((milestone) => progress >= milestone && !announced.has(milestone));
  if (crossed.length !== 1) {
    for (const milestone of crossed) announced.add(milestone);
    return;
  }

  const milestone = crossed[0]!;
  announced.add(milestone);
  await prisma.jobEvent.create({
    data: {
      jobId,
      eventType: 'PROGRESS',
      message: `Execution ${execution.number} processed ${processedRows.toLocaleString()} row${processedRows === 1 ? '' : 's'} (${milestone}%)`,
      metadata: {
        progress: milestone,
        processedRows,
        executionId: execution.id,
        executionNumber: execution.number,
      },
    },
  });
}
