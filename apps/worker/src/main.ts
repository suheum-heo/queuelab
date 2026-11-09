import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { findRepoRoot, storagePath } from './env';

loadEnv({ path: resolve(findRepoRoot(__dirname), '.env') });

import { createPrismaClient } from '@queuelab/database';
import { resolveCsvAnalysisQueue, type CsvAnalysisPayload } from '@queuelab/shared-types';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createJobNotifier } from './job-notifier';
import { markFailed, processCsvJob } from './process-csv-job';

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
  const worker = new Worker<CsvAnalysisPayload>(
    queueName,
    (job) => processCsvJob(prisma, job, storage, notifier),
    { connection, concurrency },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    void markFailed(prisma, job, error, notifier).catch((recordError: unknown) => {
      console.error('[worker] could not record failure', recordError);
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
    await notifier.close();
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
