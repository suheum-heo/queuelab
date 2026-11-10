import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { findRepoRoot, storagePath } from './env';

loadEnv({ path: resolve(findRepoRoot(__dirname), '.env') });

import { createPrismaClient } from '@queuelab/database';
import { resolveCsvAnalysisQueue, type CsvAnalysisPayload } from '@queuelab/shared-types';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createJobNotifier } from './job-notifier';
import { markFailed, processCsvJob, recordWorkerStall } from './process-csv-job';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const prisma = createPrismaClient(databaseUrl);
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const notifier = createJobNotifier(redisUrl);
  const storage = storagePath(findRepoRoot(__dirname));
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

  const queueName = resolveCsvAnalysisQueue();
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<CsvAnalysisPayload>(queueName, { connection: queueConnection });
  const worker = new Worker<CsvAnalysisPayload>(
    queueName,
    (job) => processCsvJob(prisma, job, storage, notifier),
    {
      connection,
      concurrency,
      lockDuration: positiveFromEnv('BULLMQ_LOCK_DURATION_MS', 30_000),
      stalledInterval: positiveFromEnv('BULLMQ_STALLED_INTERVAL_MS', 30_000),
      maxStalledCount: countFromEnv('BULLMQ_MAX_STALLED_COUNT', 1),
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    void markFailed(prisma, job, error, notifier).catch((recordError: unknown) => {
      console.error('[worker] could not record failure', recordError);
    });
  });

  worker.on('stalled', (executionId) => {
    void recordWorkerStall(prisma, queue, executionId, notifier).catch((recordError: unknown) => {
      console.error('[worker] could not record stall', recordError);
    });
  });

  worker.on('error', (error) => {
    console.error('[worker]', error);
  });

  console.log(`[worker] listening on ${queueName} (concurrency ${concurrency})`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[worker] shutting down');
    await worker.close();
    await queue.close();
    await notifier.close();
    await prisma.$disconnect();
    await connection.quit();
    await queueConnection.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();

function positiveFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function countFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
