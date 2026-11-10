import { config as loadEnv } from 'dotenv';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@queuelab/database';
import { localObjectStore } from '@queuelab/storage';
import { reportObjectKey, type CsvAnalysisPayload } from '@queuelab/shared-types';
import { findRepoRoot, storagePath } from '../../../worker/src/env';
import { markFailed, processCsvJob } from '../../../worker/src/process-csv-job';
import { enqueueExecution } from '../queue/queue.service';
import { reconcileJobs } from './reconcile';

loadEnv({ path: resolve(__dirname, '../../../../.env') });

const repo = findRepoRoot(__dirname);
const queueName = `csv-analysis-recovery-${process.pid}`;
const storage = storagePath(repo);
const files = localObjectStore(storage);
const createdIds: string[] = [];
const logs = { worker: '' };

describe('crash recovery and reconciliation', { concurrency: 1 }, () => {
  let prisma: PrismaClient;
  let connection: Redis;
  let queue: Queue<CsvAnalysisPayload>;
  let userId: string;

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    prisma = createPrismaClient(databaseUrl);
    const user = await prisma.user.upsert({
      where: { email: process.env.DEMO_USER_EMAIL ?? 'demo@queuelab.dev' },
      update: {},
      create: { email: process.env.DEMO_USER_EMAIL ?? 'demo@queuelab.dev' },
    });
    userId = user.id;
    connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    queue = new Queue<CsvAnalysisPayload>(queueName, { connection });
  });

  after(async () => {
    const jobs = createdIds.length
      ? await prisma.job.findMany({
          where: { id: { in: createdIds } },
          select: { id: true, inputKey: true },
        })
      : [];
    if (createdIds.length) await prisma.job.deleteMany({ where: { id: { in: createdIds } } });
    await Promise.all(
      jobs.flatMap((job) => [
        job.inputKey ? rm(resolve(storage, job.inputKey), { force: true }) : Promise.resolve(),
        rm(resolve(storage, `results/${job.id}`), { recursive: true, force: true }),
        rm(resolve(storage, `results/${job.id}.json`), { force: true }),
      ]),
    );
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  });

  it('queues one pending execution when two reconcilers race, then stores one result', async () => {
    const job = await insertJob('it-pending.csv', 'order_id,sku,quantity,amount\n1,a,2,4.50\n');
    const [first, second] = await Promise.all([runReconcile(job.id), runReconcile(job.id)]);
    assert.equal(first.pendingRecovered + second.pendingRecovered, 1);

    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'QUEUED');
    assert.equal(saved.currentExecutionId, job.executionId);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 1);
    assert.equal(await queue.getJob(job.executionId).then((entry) => entry?.id), job.executionId);
    const events = await eventTypes(job.id);
    assert.equal(events.filter((type) => type === 'ENQUEUE_RECOVERED').length, 1);

    const worker = startWorker();
    try {
      await waitForJob(job.id, (row) => row.status === 'COMPLETED');
    } finally {
      await stopWorker(worker);
    }
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 1);
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(result.executionId, job.executionId);
    assert.equal(result.totalRows, 1);
    const report = await readFile(resolve(storage, reportObjectKey(job.id, job.executionId)), 'utf8');
    assert.match(report, /"totalRows": 1/);
  });

  it('leaves a young pending execution alone and does not enqueue a second copy', async () => {
    const job = await insertJob('it-young.csv', 'order_id,sku,quantity,amount\n1,a,1,1.00\n');
    await enqueueExecution(queue, queueName, payloadOf(job));
    const summary = await runReconcile(job.id, { minPendingAgeMs: 60 * 60 * 1000 });
    assert.equal(summary.pendingRecovered, 0);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'PENDING_ENQUEUE');
    assert.ok(await queue.getJob(job.executionId));
  });

  it('marks a pending execution queued when Redis already has that execution id', async () => {
    const job = await insertJob('it-present.csv', 'order_id,sku,quantity,amount\n1,a,1,1.00\n');
    await enqueueExecution(queue, queueName, payloadOf(job));
    const again = await enqueueExecution(queue, queueName, payloadOf(job));
    assert.equal(again, 'present');
    const summary = await runReconcile(job.id);
    assert.equal(summary.pendingRecovered, 1);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'QUEUED');
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'paused');
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0) >= 1, true);
  });

  it('copies a BullMQ failure into the ledger instead of queueing the execution again', async () => {
    const job = await insertJob('it-sync-fail.csv', 'order_id,sku,quantity,amount\n1,a,1,1.00\n', {
      status: 'PROCESSING',
    });
    await enqueueExecution(queue, queueName, payloadOf(job));
    const failingConnection = duplicateConnection();
    const failing = new Worker(
      queueName,
      async () => {
        throw new UnrecoverableError('permanent worker failure');
      },
      { connection: failingConnection, stalledInterval: 30_000, lockDuration: 30_000 },
    );
    try {
      await waitFor(async () => (await (await queue.getJob(job.executionId))?.getState()) === 'failed');
    } finally {
      await failing.close();
      await failingConnection.quit();
    }
    const summary = await runReconcile(job.id, { stuckAfterMs: 0 });
    assert.equal(summary.failuresSynced, 1);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'FAILED');
    assert.match(saved.errorMessage ?? '', /permanent worker failure/);
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 0);
    const events = await eventTypes(job.id);
    assert.ok(events.includes('FAILED'));
  });

  it('marks the ledger completed when BullMQ finished and the result is already stored', async () => {
    const job = await insertJob('it-repair.csv', 'order_id,sku,quantity,amount\n3,c,4,8.00\n', {
      status: 'QUEUED',
    });
    await enqueueExecution(queue, queueName, payloadOf(job));
    const worker = startWorker();
    try {
      await waitForJob(job.id, (row) => row.status === 'COMPLETED');
    } finally {
      await stopWorker(worker);
    }
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'PROCESSING', finishedAt: null, enqueueClaimedAt: null },
    });
    const summary = await runReconcile(job.id, { stuckAfterMs: 0 });
    assert.equal(summary.completionsRepaired, 1);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'COMPLETED');
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 1);
    assert.ok((await eventTypes(job.id)).includes('RECOVERED'));
  });

  it('requeues an active ledger row whose queue record disappeared', async () => {
    const job = await insertJob('it-missing.csv', 'order_id,sku,quantity,amount\n1,a,1,1.00\n', {
      status: 'PROCESSING',
    });
    const summary = await runReconcile(job.id, { stuckAfterMs: 0 });
    assert.equal(summary.queueRestored, 1);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'QUEUED');
    assert.equal(saved.currentExecutionId, job.executionId);
    assert.ok(await queue.getJob(job.executionId));
    assert.ok((await eventTypes(job.id)).includes('QUEUE_RECOVERED'));
  });

  it('resumes a killed worker on the same execution and keeps one result', { timeout: 30_000 }, async () => {
    const job = await insertJob('it-stall.csv', 'order_id,sku,quantity,amount\n5,d,2,3.00\n', {
      status: 'QUEUED',
      fault: 'stall-once',
    });
    await enqueueExecution(queue, queueName, payloadOf(job));
    const crashed = startWorker({ lock: '500', stalled: '500', maxStalled: '1' });
    await waitForJob(job.id, (row) => row.status === 'PROCESSING');
    await killWorker(crashed);
    const recovered = startWorker({ lock: '500', stalled: '500', maxStalled: '1' });
    try {
      await waitFor(async () => {
        const row = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } });
        const events = await eventTypes(job.id);
        return row?.status === 'COMPLETED' && events.includes('STALLED') && events.includes('COMPLETED');
      }, 25_000);
    } finally {
      await stopWorker(recovered);
    }
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.currentExecutionId, job.executionId);
    assert.equal(saved.executionNumber, 1);
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 1);
    const events = await eventTypes(job.id);
    assert.ok(events.includes('PROCESSING'));
    assert.ok(events.includes('STALLED'));
    assert.ok(events.includes('COMPLETED'));
    assert.equal(events.filter((type) => type === 'COMPLETED').length, 1);
  });

  it('fails the execution when the worker keeps dying past the stall limit', { timeout: 30_000 }, async () => {
    const job = await insertJob('it-stall-limit.csv', 'order_id,sku,quantity,amount\n5,d,2,3.00\n', {
      status: 'QUEUED',
      fault: 'stall-forever',
    });
    await enqueueExecution(queue, queueName, payloadOf(job));
    const crashed = startWorker({ lock: '400', stalled: '400', maxStalled: '0' });
    await waitForJob(job.id, (row) => row.status === 'PROCESSING');
    await killWorker(crashed);
    const observer = startWorker({ lock: '400', stalled: '400', maxStalled: '0' });
    try {
      await waitFor(async () => {
        const row = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } });
        const events = await eventTypes(job.id);
        return row?.status === 'FAILED' && events.includes('STALLED') && events.includes('FAILED');
      }, 25_000);
    } finally {
      await stopWorker(observer);
    }
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.match(saved.errorMessage ?? '', /stalled more than allowable limit/);
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 0);
    const events = await eventTypes(job.id);
    assert.ok(events.includes('STALLED'));
    assert.ok(events.includes('FAILED'));
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 1);
  });

  it('keeps one result across crashes before, during, and after the report write', async () => {
    const before = await insertJob('it-before.csv', 'order_id,sku,quantity,amount\n7,e,1,2.00\n', {
      status: 'QUEUED',
      crashAt: 'before-report',
    });
    await expectCrash(before, 'before-report');
    assert.equal(await fileExists(reportObjectKey(before.id, before.executionId)), false);
    assert.equal(await prisma.jobResult.count({ where: { jobId: before.id } }), 0);
    await finishAfterCrash(before);
    assert.equal(await prisma.jobResult.count({ where: { jobId: before.id } }), 1);

    const midway = await insertJob('it-mid.csv', 'order_id,sku,quantity,amount\n8,f,1,3.00\n', {
      status: 'QUEUED',
      crashAt: 'after-report',
    });
    await expectCrash(midway, 'after-report');
    const partial = JSON.parse(await readFile(resolve(storage, reportObjectKey(midway.id, midway.executionId)), 'utf8')) as {
      totalRows: number;
    };
    assert.equal(partial.totalRows, 1);
    assert.equal(await prisma.jobResult.count({ where: { jobId: midway.id } }), 0);
    await finishAfterCrash(midway);
    assert.equal(await prisma.jobResult.count({ where: { jobId: midway.id } }), 1);

    const after = await insertJob('it-after.csv', 'order_id,sku,quantity,amount\n9,g,1,4.00\n', {
      status: 'QUEUED',
      crashAt: 'after-upsert',
    });
    await expectCrash(after, 'after-upsert');
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: after.id } })).status, 'COMPLETED');
    await markFailed(prisma, fakeJob(after, 1), new Error('Simulated crash at after-upsert'), noopNotifier);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: after.id } })).status, 'COMPLETED');
    await processCsvJob(prisma, fakeJob(after, 1), files, noopNotifier);
    assert.equal(await prisma.jobResult.count({ where: { jobId: after.id } }), 1);
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: after.id } });
    assert.equal(result.executionId, after.executionId);
  });

  it('does not let an old execution replace the current execution report file', async () => {
    const job = await insertJob('it-report-stale.csv', 'order_id,sku,quantity,amount\n4,c,1,2.00\n', {
      status: 'QUEUED',
    });
    await processCsvJob(prisma, fakeJob(job, 0), files, noopNotifier);
    const replacementId = randomUUID();
    const replacementKey = reportObjectKey(job.id, replacementId);
    await mkdir(resolve(storage, `results/${job.id}`), { recursive: true });
    await writeFile(resolve(storage, replacementKey), '{"owner":"execution-2"}');
    await prisma.jobExecution.create({
      data: { id: replacementId, jobId: job.id, number: 2, status: 'COMPLETED' },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        currentExecutionId: replacementId,
        executionNumber: 2,
        status: 'COMPLETED',
        resultKey: replacementKey,
      },
    });
    await prisma.jobResult.update({
      where: { jobId: job.id },
      data: { executionId: replacementId, totalRows: 99 },
    });

    await processCsvJob(prisma, fakeJob(job, 0), files, noopNotifier);

    assert.equal(await readFile(resolve(storage, replacementKey), 'utf8'), '{"owner":"execution-2"}');
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(result.executionId, replacementId);
    assert.equal(result.totalRows, 99);
    assert.equal(await prisma.jobResult.count({ where: { jobId: job.id } }), 1);
  });

  async function insertJob(
    filename: string,
    csv: string,
    extra: { status?: 'PENDING_ENQUEUE' | 'QUEUED' | 'PROCESSING'; crashAt?: 'before-report' | 'after-report' | 'after-upsert'; fault?: 'stall-once' | 'stall-forever' } = {},
  ): Promise<Inserted> {
    const id = randomUUID();
    const executionId = randomUUID();
    const key = `uploads/${id}.csv`;
    await mkdir(resolve(storage, 'uploads'), { recursive: true });
    await writeFile(resolve(storage, key), csv);
    const status = extra.status ?? 'PENDING_ENQUEUE';
    const createdAt = new Date(Date.now() - 5_000);
    await prisma.job.create({
      data: {
        id,
        userId,
        type: 'CSV_ANALYSIS',
        status,
        maxAttempts: 3,
        inputKey: key,
        executionNumber: 1,
        currentExecutionId: executionId,
        createdAt,
        startedAt: status === 'PROCESSING' ? new Date(Date.now() - 60_000) : null,
        options: {
          delimiter: ',',
          hasHeader: true,
          filename,
          ...(extra.crashAt ? { crashAt: extra.crashAt } : {}),
          ...(extra.fault ? { fault: extra.fault } : {}),
        },
        executions: {
          create: {
            id: executionId,
            number: 1,
            status,
            createdAt,
            startedAt: status === 'PROCESSING' ? new Date(Date.now() - 60_000) : null,
          },
        },
      },
    });
    createdIds.push(id);
    return { id, executionId, fileKey: key, filename, crashAt: extra.crashAt, fault: extra.fault };
  }

  function payloadOf(job: Inserted): CsvAnalysisPayload {
    return {
      jobId: job.id,
      executionId: job.executionId,
      fileKey: job.fileKey,
      options: {
        delimiter: ',',
        hasHeader: true,
        filename: job.filename,
        ...(job.crashAt ? { crashAt: job.crashAt } : {}),
        ...(job.fault ? { fault: job.fault } : {}),
      },
    };
  }

  async function runReconcile(
    jobId: string,
    overrides: { minPendingAgeMs?: number; stuckAfterMs?: number } = {},
  ) {
    return reconcileJobs(prisma, queue, async () => undefined, {
      minPendingAgeMs: overrides.minPendingAgeMs ?? 0,
      stuckAfterMs: overrides.stuckAfterMs ?? 120_000,
      claimLeaseMs: 20_000,
      jobIds: [jobId],
    });
  }

  async function expectCrash(job: Inserted, point: string): Promise<void> {
    await assert.rejects(
      () => processCsvJob(prisma, fakeJob(job, 0), files, noopNotifier),
      (error: unknown) => error instanceof Error && error.message === `Simulated crash at ${point}`,
    );
  }

  async function finishAfterCrash(job: Inserted): Promise<void> {
    await markFailed(prisma, fakeJob(job, 1), new Error(`Simulated crash at ${job.crashAt}`), noopNotifier);
    await processCsvJob(prisma, fakeJob(job, 1), files, noopNotifier);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETED');
  }

  function startWorker(stall?: { lock: string; stalled: string; maxStalled: string }): ChildProcess {
    logs.worker = '';
    const child = spawn(process.execPath, workerLaunchArgs(), {
      cwd: resolve(repo, 'apps/worker'),
      env: {
        ...process.env,
        CSV_ANALYSIS_QUEUE: queueName,
        ...(stall
          ? {
              BULLMQ_LOCK_DURATION_MS: stall.lock,
              BULLMQ_STALLED_INTERVAL_MS: stall.stalled,
              BULLMQ_MAX_STALLED_COUNT: stall.maxStalled,
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer) => {
      logs.worker += chunk.toString();
      if (logs.worker.length > 12_000) logs.worker = logs.worker.slice(-8_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return child;
  }

  function duplicateConnection(): Redis {
    return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  }

  async function waitForJob(
    id: string,
    done: (job: { status: string; errorMessage: string | null }) => boolean,
    timeoutMs = 12_000,
  ): Promise<void> {
    const started = Date.now();
    let latest = '';
    while (Date.now() - started < timeoutMs) {
      const row = await prisma.job.findUnique({ where: { id }, select: { status: true, errorMessage: true } });
      latest = `${row?.status ?? 'missing'} ${row?.errorMessage ?? ''}`;
      if (row && done(row)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${id}. Last ${latest}\n${logs.worker}`);
  }

  async function waitFor(done: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await done()) return;
      await delay(100);
    }
    throw new Error(`Timed out\n${logs.worker}`);
  }

  async function eventTypes(id: string): Promise<string[]> {
    const events = await prisma.jobEvent.findMany({
      where: { jobId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { eventType: true },
    });
    return events.map((event) => event.eventType);
  }

  async function fileExists(key: string): Promise<boolean> {
    return existsSync(resolve(storage, key));
  }
});

interface Inserted {
  id: string;
  executionId: string;
  fileKey: string;
  filename: string;
  crashAt?: 'before-report' | 'after-report' | 'after-upsert';
  fault?: 'stall-once' | 'stall-forever';
}

const noopNotifier = { async publish() {}, async close() {} };

function fakeJob(job: Inserted, attemptsMade: number): Job<CsvAnalysisPayload> {
  return {
    data: {
      jobId: job.id,
      executionId: job.executionId,
      fileKey: job.fileKey,
      options: {
        delimiter: ',',
        hasHeader: true,
        filename: job.filename,
        ...(job.crashAt ? { crashAt: job.crashAt } : {}),
        ...(job.fault ? { fault: job.fault } : {}),
      },
    },
    attemptsMade,
    stalledCounter: 0,
    opts: { attempts: 3 },
    updateProgress: async () => undefined,
  } as unknown as Job<CsvAnalysisPayload>;
}

function workerLaunchArgs(): string[] {
  const require = createRequire(resolve(repo, 'apps/worker/package.json'));
  const tsxDir = resolve(require.resolve('tsx/package.json'), '..');
  return [
    '--require',
    resolve(tsxDir, 'dist/preflight.cjs'),
    '--import',
    pathToFileURL(resolve(tsxDir, 'dist/loader.mjs')).href,
    'src/main.ts',
  ];
}

async function killWorker(child: ChildProcess): Promise<void> {
  signal(child, 'SIGKILL');
  await exited(child, 1_000);
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signal(child, 'SIGTERM');
  const stopped = await exited(child, 2_000);
  if (!stopped) signal(child, 'SIGKILL');
  await exited(child, 1_000);
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(child.pid, name);
  } catch {
    // The process already exited.
  }
}

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => resolveStop(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
