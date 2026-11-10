import { config as loadEnv } from 'dotenv';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@queuelab/database';
import type { CsvAnalysisPayload, JobView } from '@queuelab/shared-types';
import type { Job } from 'bullmq';
import { findRepoRoot, storagePath } from '../../../worker/src/env';
import { accessToken } from '../auth/test-login';
import { processCsvJob } from '../../../worker/src/process-csv-job';

loadEnv({ path: resolve(__dirname, '../../../../.env') });
process.env.CSV_ANALYSIS_QUEUE = `csv-analysis-retry-${process.pid}`;

const SEEDED_FAILED_JOB = '10000000-0000-4000-8000-000000000003';
const createdIds: string[] = [];
const repo = findRepoRoot(__dirname);
const logs = { api: '', worker: '' };

describe('manual retry and transient recovery', { concurrency: 1 }, () => {
  let prisma: PrismaClient;
  let api: ChildProcess;
  let worker: ChildProcess;
  let base: string;
  let token = '';
  const storage = storagePath(repo);

  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    if (!existsSync(resolve(repo, 'apps/api/dist/main.js'))) {
      throw new Error('Build the API before this test: pnpm --filter @queuelab/api build');
    }

    prisma = createPrismaClient(databaseUrl);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const redirectUri = `${origin}/api/v1/auth/callback`;
    base = `${origin}/api/v1`;
    const env = {
      ...process.env,
      PORT: String(port),
      WEB_ORIGIN: origin,
      OIDC_ISSUER: '',
      OIDC_CLIENT_ID: 'queuelab',
      OIDC_REDIRECT_URI: redirectUri,
      CSV_ANALYSIS_QUEUE: process.env.CSV_ANALYSIS_QUEUE,
    };

    api = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(repo, 'apps/api'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    capture(api, 'api');
    worker = spawn(process.execPath, [tsxCli(), 'src/main.ts'], {
      cwd: resolve(repo, 'apps/worker'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    capture(worker, 'worker');

    await waitForHealth(base, () => logs.api);
    token = await accessToken(origin, {
      email: process.env.DEMO_USER_EMAIL ?? 'demo@queuelab.dev',
      redirectUri,
    });
  });

  after(async () => {
    await stop(worker);
    await stop(api);
    const jobs = createdIds.length
      ? await prisma.job.findMany({
          where: { id: { in: createdIds } },
          select: { id: true, inputKey: true },
        })
      : [];
    if (createdIds.length) {
      await prisma.job.deleteMany({ where: { id: { in: createdIds } } });
    }
    await Promise.all(
      jobs.flatMap((job) => [
        job.inputKey ? rm(resolve(storage, job.inputKey), { force: true }) : Promise.resolve(),
        job.inputKey
          ? rm(resolve(storage, job.inputKey.replace(/\.csv$/, '.json')), { force: true })
          : Promise.resolve(),
        rm(resolve(storage, `results/${job.id}.json`), { force: true }),
      ]),
    );
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(process.env.CSV_ANALYSIS_QUEUE ?? 'csv-analysis', { connection });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  });

  it('succeeds on attempt 2 after one transient failure and stores one result', async () => {
    const job = await dispatch('it-transient.csv', 'order_id,sku,quantity,amount\n1,a,2,4.50\n', {
      demoFailure: 'transient',
    });
    const finished = await waitFor(
      job.id,
      (current) => current.status === 'COMPLETED' || current.status === 'FAILED',
    );

    assert.equal(finished.status, 'COMPLETED', failureContext(finished));
    assert.equal(finished.executionNumber, 1);
    assert.equal(finished.attemptsMade, 2);
    const events = await eventTypes(job.id);
    assert.ok(events.includes('RETRYING'));
    assert.equal(await resultCount(job.id), 1);
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(result.executionId, finished.executionId);
    assert.equal(result.totalRows, 1);
    assert.equal(result.validRows, 1);
  });

  it('does not retry a malformed CSV', async () => {
    const job = await dispatch(
      'it-broken.csv',
      'order_id,sku,quantity,amount\n"1,a,1,1.00\n',
    );
    const finished = await waitFor(job.id, (current) => current.status === 'FAILED');

    assert.equal(finished.attemptsMade, 1);
    assert.equal(finished.executionNumber, 1);
    const events = await eventTypes(job.id);
    assert.equal(events.includes('RETRYING'), false);
    assert.equal(await resultCount(job.id), 0);
  });

  it('starts one new execution when retry is requested twice, then keeps a single result', async () => {
    const job = await dispatch(
      'it-exhaust.csv',
      'order_id,sku,quantity,amount\n9,b,3,6.00\n',
      { demoFailure: 'exhaust-first-execution' },
    );
    const failed = await waitFor(
      job.id,
      (current) => current.status === 'FAILED' && current.attemptsMade === 3,
      20_000,
    );
    assert.equal(failed.executionNumber, 1);
    const historyBefore = await eventTypes(job.id);
    assert.ok(historyBefore.includes('RETRYING'));
    assert.ok(historyBefore.includes('FAILED'));

    const [first, second] = await Promise.all([retry(job.id), retry(job.id)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [202, 409]);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 2);

    const finished = await waitFor(job.id, (current) => current.status === 'COMPLETED', 15_000);
    assert.equal(finished.executionNumber, 2);
    assert.equal(finished.attemptsMade, 1);
    assert.equal(await resultCount(job.id), 1);
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(result.executionId, finished.executionId);
    assert.equal(result.totalRows, 1);
    const history = await eventTypes(job.id);
    assert.ok(history.includes('RETRY_REQUESTED'));
    assert.ok(history.indexOf('FAILED') < history.indexOf('RETRY_REQUESTED'));
    assert.equal(history.filter((type) => type === 'FAILED').length, 1);

    const again = await retry(job.id);
    assert.equal(again.status, 409);
  });

  it('refuses to retry a sample job', async () => {
    const response = await retry(SEEDED_FAILED_JOB);
    assert.equal(response.status, 400);
  });

  it('does not let an old execution overwrite the current result', async () => {
    const job = await dispatch('it-stale.csv', 'order_id,sku,quantity,amount\n4,c,1,2.00\n');
    const finished = await waitFor(job.id, (current) => current.status === 'COMPLETED');
    const originalExecutionId = finished.executionId;
    assert.ok(originalExecutionId);
    assert.ok(finished.inputKey);
    const replacementId = randomUUID();
    await prisma.jobExecution.create({
      data: { id: replacementId, jobId: job.id, number: 2, status: 'FAILED' },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { currentExecutionId: replacementId, executionNumber: 2, status: 'FAILED', attempts: 3 },
    });

    await processCsvJob(
      prisma,
      {
        data: {
          jobId: job.id,
          executionId: originalExecutionId,
          fileKey: finished.inputKey,
          options: { delimiter: ',', hasHeader: true, filename: 'it-stale.csv' },
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
        updateProgress: async () => undefined,
      } as unknown as Job<CsvAnalysisPayload>,
      storage,
      { async publish() {}, async close() {} },
    );

    const current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const result = await prisma.jobResult.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(current.currentExecutionId, replacementId);
    assert.equal(current.status, 'FAILED');
    assert.equal(result.executionId, originalExecutionId);
    assert.equal(await resultCount(job.id), 1);
  });

  function failureContext(job: JobView): string {
    return `${job.status} attempt ${job.attemptsMade}: ${job.errorMessage ?? ''}\n${logs.worker}`;
  }

  async function dispatch(
    filename: string,
    csv: string,
    options: Record<string, string> = {},
  ): Promise<JobView> {
    const uploadBody = new FormData();
    uploadBody.append('file', new File([csv], filename, { type: 'text/csv' }));
    const uploaded = await fetch(`${base}/uploads`, withAuth({ method: 'POST', body: uploadBody }));
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 201, uploadedText);
    const upload = JSON.parse(uploadedText) as { id: string };
    const created = await fetch(
      `${base}/jobs`,
      withAuth({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'CSV_ANALYSIS',
          fileId: upload.id,
          options,
        }),
      }),
    );
    const createdText = await created.text();
    assert.equal(created.status, 202, createdText);
    const job = JSON.parse(createdText) as JobView;
    createdIds.push(job.id);
    return job;
  }

  async function retry(id: string): Promise<Response> {
    return fetch(`${base}/jobs/${id}/retry`, withAuth({ method: 'POST' }));
  }

  async function waitFor(
    id: string,
    done: (job: JobView) => boolean,
    timeoutMs = 12_000,
  ): Promise<JobView> {
    const started = Date.now();
    let latest: JobView | undefined;
    while (Date.now() - started < timeoutMs) {
      const response = await fetch(`${base}/jobs/${id}`, withAuth());
      latest = (await response.json()) as JobView;
      if (done(latest)) return latest;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(
      `Timed out waiting for ${id}. Last status ${latest?.status} attempt ${latest?.attemptsMade} ${latest?.errorMessage ?? ''}\nworker:\n${logs.worker}\napi:\n${logs.api}`,
    );
  }

  async function eventTypes(id: string): Promise<string[]> {
    const events = await prisma.jobEvent.findMany({
      where: { jobId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { eventType: true },
    });
    return events.map((event) => event.eventType);
  }

  async function resultCount(id: string): Promise<number> {
    return prisma.jobResult.count({ where: { jobId: id } });
  }

  function withAuth(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return { ...init, headers };
  }
});

function tsxCli(): string {
  const candidates = [
    resolve(repo, 'apps/worker/node_modules/tsx/dist/cli.mjs'),
    resolve(repo, 'apps/api/node_modules/tsx/dist/cli.mjs'),
    resolve(repo, 'node_modules/tsx/dist/cli.mjs'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('tsx is not installed');
  return found;
}

function capture(child: ChildProcess, key: 'api' | 'worker'): void {
  const append = (chunk: Buffer) => {
    logs[key] += chunk.toString();
    if (logs[key].length > 12_000) logs[key] = logs[key].slice(-8_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(base: string, log: () => string): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 20_000) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
      last = await response.text();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`API did not become healthy: ${last}\n${log()}`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}
