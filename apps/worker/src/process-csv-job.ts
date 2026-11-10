import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Prisma, type PrismaClient } from '@queuelab/database';
import {
  DEFAULT_MAX_ATTEMPTS,
  reportObjectKey,
  type CsvAnalysisOptions,
  type CsvAnalysisPayload,
  type CrashPoint,
} from '@queuelab/shared-types';
import { Job, Queue, UnrecoverableError } from 'bullmq';
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
 * The report file is results/{jobId}/{executionId}.json, written before the
 * ledger commit. A newer execution uses a different path, so a late rename
 * cannot replace its bytes. A crash before the commit leaves the file for the
 * next attempt of this same execution to overwrite.
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
  const stalls = job.stalledCounter ?? 0;
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
      message:
        stalls > 0
          ? `Execution ${execution.number} resumed after ${stalls} stall${stalls === 1 ? '' : 's'} and claimed the file again (attempt ${attempt}). The CSV is read from the first row.`
          : `Execution ${execution.number}, attempt ${attempt} claimed the file`,
      metadata: {
        attempt,
        stalls,
        executionId: execution.id,
        executionNumber: execution.number,
        fileKey: payload.fileKey,
      },
    },
  });
  await notifier.publish(record.id, 'PROCESSING');
  await hangIfFault(payload.options, stalls);

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

  if (!(await isCurrent(prisma, record.id, payload.executionId))) return;
  crashOnce(payload.options, 'before-report', job.attemptsMade);

  const reportKey = reportObjectKey(record.id, execution.id);
  const finalPath = resolve(root, reportKey);
  const temporary = `${finalPath}.tmp`;
  if (!finalPath.startsWith(root + sep) || !temporary.startsWith(root + sep)) {
    throw new UnrecoverableError('Refusing to write a report outside storage');
  }
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(temporary, JSON.stringify(analysis, null, 2));
  await rename(temporary, finalPath);
  crashOnce(payload.options, 'after-report', job.attemptsMade);
  if (!(await isCurrent(prisma, record.id, payload.executionId))) {
    await rm(finalPath, { force: true });
    return;
  }

  const won = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: { id: record.id, currentExecutionId: payload.executionId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        resultKey: reportKey,
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
          resultKey: reportKey,
          totalRows: analysis.totalRows,
          validRows: analysis.validRows,
          invalidRows: analysis.invalidRows,
        },
      },
    });
    return true;
  });

  if (!won) {
    await rm(finalPath, { force: true });
    return;
  }

  crashOnce(payload.options, 'after-upsert', job.attemptsMade);
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
  const stalledOut = error.message.includes('stalled more than allowable limit');

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
      message: stalledOut
        ? `Execution ${executionNumber} stopped after the worker stalled more than BullMQ allows. It was not queued again.`
        : willRetry
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

/**
 * BullMQ emits this on the worker that notices the expired lock. The execution
 * id is the queue job id. The ledger keeps the original attempt and appends
 * the stall; it does not start a new execution.
 */
export async function recordWorkerStall(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  executionId: string,
  notifier: JobNotifier,
): Promise<void> {
  const bullJob = await queue.getJob(executionId);
  const payload = bullJob?.data;
  if (!payload?.jobId || payload.executionId !== executionId) return;

  const current = await prisma.job.findUnique({ where: { id: payload.jobId } });
  if (!current || current.currentExecutionId !== executionId) return;
  if (current.status === 'COMPLETED' || current.status === 'FAILED') return;

  const execution = await prisma.jobExecution.findUnique({ where: { id: executionId } });
  const stalls = Math.max(1, bullJob?.stalledCounter ?? 1);
  await prisma.jobEvent.create({
    data: {
      jobId: current.id,
      eventType: 'STALLED',
      message: `Execution ${execution?.number ?? current.executionNumber} stalled (${stalls}). BullMQ will run this same execution again until the stall limit is reached.`,
      metadata: { executionId, stalledCount: stalls, executionNumber: execution?.number ?? current.executionNumber },
    },
  });
  await notifier.publish(current.id, 'STALLED');
}

function crashOnce(options: CsvAnalysisOptions | undefined, point: CrashPoint, attemptsMade: number): void {
  if (options?.crashAt === point && attemptsMade === 0) {
    throw new Error(`Simulated crash at ${point}`);
  }
}

async function hangIfFault(options: CsvAnalysisOptions | undefined, stalls: number): Promise<void> {
  if (options?.fault === 'stall-forever' || (options?.fault === 'stall-once' && stalls === 0)) {
    await new Promise(() => {});
  }
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
