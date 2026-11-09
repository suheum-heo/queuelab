import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Prisma, type PrismaClient } from '@queuelab/database';
import { DEFAULT_MAX_ATTEMPTS, type CsvAnalysisPayload } from '@queuelab/shared-types';
import { Job, UnrecoverableError } from 'bullmq';
import { analyzeCsvFile, permanentCsvError } from './csv/analyze-file';
import type { JobNotifier } from './job-notifier';

const UPLOAD_KEY =
  /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.csv$/i;

/**
 * Safe to run more than once. A completed job returns immediately.
 * Each attempt reads the CSV from the start. The report file is replaced
 * atomically and JobResult is upserted on job_id, so a retry cannot insert
 * a second result row.
 */
export async function processCsvJob(
  prisma: PrismaClient,
  job: Job<CsvAnalysisPayload>,
  storageRoot: string,
  notifier: JobNotifier,
): Promise<void> {
  const payload = job.data;
  if (!payload?.jobId) {
    throw new UnrecoverableError('Job payload is missing jobId');
  }

  const record = await prisma.job.findUnique({ where: { id: payload.jobId } });
  if (!record) {
    throw new UnrecoverableError(`Job ${payload.jobId} does not exist`);
  }
  if (record.status === 'COMPLETED') {
    return;
  }
  if (!payload.fileKey || !UPLOAD_KEY.test(payload.fileKey)) {
    throw new UnrecoverableError('Job is missing its uploaded CSV');
  }

  const root = resolve(storageRoot);
  const source = resolve(root, payload.fileKey);
  if (!source.startsWith(root + sep)) {
    throw new UnrecoverableError('Upload path escapes storage');
  }

  const attempt = job.attemptsMade + 1;
  await prisma.job.update({
    where: { id: record.id },
    data: {
      status: 'PROCESSING',
      attempts: attempt,
      progress: 0,
      startedAt: record.startedAt ?? new Date(),
      finishedAt: null,
      errorMessage: null,
    },
  });
  await prisma.jobEvent.create({
    data: {
      jobId: record.id,
      eventType: 'PROCESSING',
      message: `Worker claimed the job on attempt ${attempt}`,
      metadata: { attempt, fileKey: payload.fileKey },
    },
  });
  await notifier.publish(record.id, 'PROCESSING');

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
        await prisma.job.update({
          where: { id: record.id },
          data: { progress },
        });
        await job.updateProgress(progress);
        if (progress < 100) {
          await recordMilestone(prisma, record.id, progress, processedRows, announced);
          await notifier.publish(record.id, 'PROGRESS');
        }
      },
    );
  } catch (error) {
    const permanent = permanentCsvError(error);
    if (permanent) throw new UnrecoverableError(permanent.message);
    throw error;
  }

  const resultKey = `results/${record.id}.json`;
  const target = resolve(root, resultKey);
  if (!target.startsWith(root + sep)) {
    throw new UnrecoverableError('Refusing to write a report outside storage');
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(analysis, null, 2));
  await rename(temporary, target);

  await prisma.jobResult.upsert({
    where: { jobId: record.id },
    create: {
      jobId: record.id,
      totalRows: analysis.totalRows,
      validRows: analysis.validRows,
      invalidRows: analysis.invalidRows,
      summary: analysis as unknown as Prisma.InputJsonValue,
    },
    update: {
      totalRows: analysis.totalRows,
      validRows: analysis.validRows,
      invalidRows: analysis.invalidRows,
      summary: analysis as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.job.update({
    where: { id: record.id },
    data: {
      status: 'COMPLETED',
      progress: 100,
      resultKey,
      finishedAt: new Date(),
      errorMessage: null,
    },
  });
  await prisma.jobEvent.create({
    data: {
      jobId: record.id,
      eventType: 'COMPLETED',
      message: `Stored report for ${analysis.totalRows.toLocaleString()} rows (${analysis.invalidRows.toLocaleString()} invalid)`,
      metadata: {
        resultKey,
        totalRows: analysis.totalRows,
        validRows: analysis.validRows,
        invalidRows: analysis.invalidRows,
      },
    },
  });
  await notifier.publish(record.id, 'COMPLETED');
}

export async function markFailed(
  prisma: PrismaClient,
  job: Job<CsvAnalysisPayload>,
  error: Error,
  notifier: JobNotifier,
): Promise<void> {
  const jobId = job.data?.jobId;
  if (!jobId) return;

  const current = await prisma.job.findUnique({ where: { id: jobId } });
  if (!current || current.status === 'COMPLETED') return;

  const maxAttempts = job.opts.attempts ?? DEFAULT_MAX_ATTEMPTS;
  const permanent = error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
  const willRetry = !permanent && job.attemptsMade < maxAttempts;

  await prisma.job.update({
    where: { id: jobId },
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
        ? `Attempt ${job.attemptsMade} failed and will be retried. ${error.message}`
        : `Failed after ${job.attemptsMade} attempt${job.attemptsMade === 1 ? '' : 's'}. ${error.message}`,
      metadata: { attempt: job.attemptsMade, willRetry },
    },
  });
  await notifier.publish(jobId, willRetry ? 'RETRYING' : 'FAILED');
}

async function recordMilestone(
  prisma: PrismaClient,
  jobId: string,
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
      message: `Processed ${processedRows.toLocaleString()} row${processedRows === 1 ? '' : 's'} (${milestone}%)`,
      metadata: { progress: milestone, processedRows },
    },
  });
}
