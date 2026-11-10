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
import { io, type Socket } from 'socket.io-client';
import { createPrismaClient, type PrismaClient } from '@queuelab/database';
import { JOB_UPDATE_EVENT, JOB_UPDATES_CHANNEL } from '@queuelab/shared-types';
import { findRepoRoot, storagePath } from '../../../worker/src/env';
import { accessToken } from './test-login';

loadEnv({ path: resolve(__dirname, '../../../../.env') });

const repo = findRepoRoot(__dirname);
const storage = storagePath(repo);
const queueName = `csv-analysis-auth-${process.pid}`;
const emailA = `a.${process.pid}@auth.queuelab.test`;
const emailB = `b.${process.pid}@auth.queuelab.test`;

describe('owner authorization', { concurrency: 1 }, () => {
  let prisma: PrismaClient;
  let api: ChildProcess;
  let origin: string;
  let base: string;
  let tokenA = '';
  let tokenB = '';
  let userA = '';
  const jobIds: string[] = [];
  const uploadIds: string[] = [];
  const logs = { api: '' };

  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    if (!existsSync(resolve(repo, 'apps/api/dist/main.js'))) {
      throw new Error('Build the API before this test: pnpm --filter @queuelab/api build');
    }
    prisma = createPrismaClient(databaseUrl);
    await deleteUsers(prisma, [emailA, emailB]);

    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    base = `${origin}/api/v1`;
    const redirectUri = `${origin}/api/v1/auth/callback`;
    api = spawn(process.execPath, ['dist/main.js'], {
      cwd: resolve(repo, 'apps/api'),
      env: {
        ...process.env,
        PORT: String(port),
        WEB_ORIGIN: origin,
        OIDC_ISSUER: '',
        OIDC_CLIENT_ID: 'queuelab',
        OIDC_REDIRECT_URI: redirectUri,
        CSV_ANALYSIS_QUEUE: queueName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk: Buffer) => append(chunk));
    api.stderr?.on('data', (chunk: Buffer) => append(chunk));
    await waitForHealth(base, () => logs.api);

    tokenA = await accessToken(origin, { email: emailA, redirectUri });
    tokenB = await accessToken(origin, { email: emailB, redirectUri });
    const me = await authed('/auth/me', tokenA);
    assert.equal(me.status, 200);
    userA = ((await me.json()) as { id: string }).id;
  });

  after(async () => {
    await stop(api);
    if (jobIds.length) await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await deleteUsers(prisma, [emailA, emailB]);
    await Promise.all(
      uploadIds.flatMap((id) => [
        rm(resolve(storage, `uploads/${id}.csv`), { force: true }),
        rm(resolve(storage, `uploads/${id}.json`), { force: true }),
      ]),
    );
    await Promise.all(
      jobIds.flatMap((id) => [
        rm(resolve(storage, `results/${id}.json`), { force: true }),
        rm(resolve(storage, `results/${id}`), { recursive: true, force: true }),
      ]),
    );
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(queueName, { connection });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  });

  it('keeps health public and rejects an anonymous job list', async () => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const jobs = await fetch(`${base}/jobs`);
    assert.equal(jobs.status, 401);
    const jwks = await fetch(`${origin}/api/v1/oidc/jwks`);
    assert.equal(jwks.status, 200);
    const body = (await jwks.json()) as { keys: unknown[] };
    assert.equal(body.keys.length, 1);
  });

  it('sets an HttpOnly session from the authorization-code callback', async () => {
    const redirectUri = `${origin}/api/v1/auth/callback`;
    const started = await fetch(`${base}/auth/login?return=/jobs`, { redirect: 'manual' });
    assert.equal(started.status, 302);
    const oidc = cookiePair(started, 'queuelab_oidc');
    const authorize = new URL(started.headers.get('location') ?? '');
    const posted = await fetch(`${origin}/api/v1/oidc/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...Object.fromEntries(authorize.searchParams),
        email: emailA,
      }),
    });
    assert.equal(posted.status, 302, await posted.clone().text());
    const callback = posted.headers.get('location');
    assert.ok(callback?.startsWith(redirectUri));
    const finished = await fetch(callback!, { redirect: 'manual', headers: { cookie: oidc } });
    assert.equal(finished.status, 302);
    assert.equal(new URL(finished.headers.get('location') ?? '').pathname, '/jobs');
    const session = cookiePair(finished, 'queuelab_id');
    assert.match(session, /HttpOnly/i);
    const me = await fetch(`${base}/auth/me`, { headers: { cookie: session.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { email: string }).email, emailA);
  });

  it('hides one user\'s job, history, report, and retry from the other', async () => {
    const id = randomUUID();
    const executionId = randomUUID();
    jobIds.push(id);
    await prisma.job.create({
      data: {
        id,
        userId: userA,
        type: 'CSV_ANALYSIS',
        status: 'COMPLETED',
        progress: 100,
        attempts: 1,
        maxAttempts: 3,
        inputKey: `uploads/${id}.csv`,
        executionNumber: 1,
        currentExecutionId: executionId,
        options: { delimiter: ',', hasHeader: true, filename: 'owned.csv' },
        executions: { create: { id: executionId, number: 1, status: 'COMPLETED' } },
        events: { create: { eventType: 'COMPLETED', message: 'Execution 1 stored the report.' } },
        result: {
          create: {
            totalRows: 1,
            validRows: 1,
            invalidRows: 0,
            executionId,
            summary: { totalRows: 1 },
          },
        },
      },
    });

    const mine = await authed(`/jobs/${id}`, tokenA);
    assert.equal(mine.status, 200);
    const theirs = await authed(`/jobs/${id}`, tokenB);
    assert.equal(theirs.status, 404);

    assert.equal((await authed(`/jobs/${id}/events`, tokenB)).status, 404);
    const events = await authed(`/jobs/${id}/events`, tokenA);
    assert.equal(events.status, 200);
    const history = (await events.json()) as { items: { eventType: string }[] };
    assert.equal(history.items[0]?.eventType, 'COMPLETED');

    assert.equal((await authed(`/jobs/${id}/result`, tokenB)).status, 404);
    assert.equal((await authed(`/jobs/${id}/result`, tokenA)).status, 200);
    assert.equal((await authed(`/jobs/${id}/download`, tokenB)).status, 404);
    const download = await authed(`/jobs/${id}/download`, tokenA);
    assert.equal(download.status, 200);
    assert.match(await download.text(), /totalRows/);
    assert.equal((await authed(`/jobs/${id}/retry`, tokenB, { method: 'POST' })).status, 404);

    const listA = (await (await authed('/jobs?limit=50', tokenA)).json()) as { items: { id: string }[] };
    const listB = (await (await authed('/jobs?limit=50', tokenB)).json()) as { items: { id: string }[] };
    assert.equal(listA.items.some((job) => job.id === id), true);
    assert.equal(listB.items.some((job) => job.id === id), false);

    const metricsA = (await (await authed('/metrics/overview', tokenA)).json()) as { total: number };
    const metricsB = (await (await authed('/metrics/overview', tokenB)).json()) as { total: number };
    const owned = await prisma.job.count({ where: { userId: userA } });
    assert.equal(metricsA.total, owned);
    assert.equal(metricsB.total, 0);
  });

  it('refuses a job created from another user\'s upload', async () => {
    const body = new FormData();
    body.append(
      'file',
      new File(['order_id,sku,quantity,amount\n1,a,1,1.00\n'], 'owned.csv', { type: 'text/csv' }),
    );
    const uploaded = await authed('/uploads', tokenA, { method: 'POST', body });
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 201, uploadedText);
    const fileId = (JSON.parse(uploadedText) as { id: string }).id;
    uploadIds.push(fileId);

    const stolen = await authed('/jobs', tokenB, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'CSV_ANALYSIS', fileId, options: { delimiter: ',', hasHeader: true } }),
    });
    assert.equal(stolen.status, 400);

    const created = await authed('/jobs', tokenA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'CSV_ANALYSIS', fileId, options: { delimiter: ',', hasHeader: true } }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 202, createdText);
    jobIds.push((JSON.parse(createdText) as { id: string }).id);
  });

  it('rejects an anonymous socket and does not deliver another user\'s notice', async () => {
    const id = randomUUID();
    jobIds.push(id);
    await prisma.job.create({
      data: {
        id,
        userId: userA,
        type: 'CSV_ANALYSIS',
        status: 'QUEUED',
        maxAttempts: 3,
        executionNumber: 1,
        options: { delimiter: ',', hasHeader: true, filename: 'socket.csv' },
      },
    });

    const anonymous = connect(origin);
    await new Promise<void>((resolveReject, reject) => {
      anonymous.on('connect', () => reject(new Error('anonymous socket connected')));
      anonymous.on('connect_error', () => resolveReject());
    });
    anonymous.close();

    const owner = connect(origin, tokenA);
    const other = connect(origin, tokenB);
    const seen: string[] = [];
    const leaked: string[] = [];
    owner.on(JOB_UPDATE_EVENT, (payload: { jobId?: string }) => {
      if (payload.jobId) seen.push(payload.jobId);
    });
    other.on(JOB_UPDATE_EVENT, (payload: { jobId?: string }) => {
      if (payload.jobId) leaked.push(payload.jobId);
    });
    await once(owner, 'connect');
    await once(other, 'connect');
    assert.deepEqual(await owner.timeout(2_000).emitWithAck('job.subscribe', id), { ok: true });
    assert.deepEqual(await other.timeout(2_000).emitWithAck('job.subscribe', id), { ok: false });
    assert.deepEqual(await other.timeout(2_000).emitWithAck('jobs.subscribe'), { ok: true });

    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    await redis.publish(
      JOB_UPDATES_CHANNEL,
      JSON.stringify({ jobId: id, eventType: 'QUEUED', occurredAt: new Date().toISOString() }),
    );
    await redis.quit();

    const started = Date.now();
    while (!seen.includes(id) && Date.now() - started < 3_000) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    owner.close();
    other.close();
    assert.deepEqual(seen, [id]);
    assert.deepEqual(leaked, []);
  });

  function append(chunk: Buffer): void {
    logs.api += chunk.toString();
    if (logs.api.length > 12_000) logs.api = logs.api.slice(-8_000);
  }

  function authed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  }
});

function connect(origin: string, token?: string): Socket {
  return io(origin, {
    path: '/socket.io',
    reconnection: false,
    timeout: 3_000,
    transports: ['websocket'],
    auth: token ? { token } : {},
  });
}

function once(socket: Socket, event: string): Promise<void> {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 3_000);
    socket.once(event, () => {
      clearTimeout(timer);
      resolveEvent();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function cookiePair(response: globalThis.Response, name: string): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!found) throw new Error(`missing ${name} cookie in ${cookies.join(' | ')}`);
  return found;
}

async function deleteUsers(prisma: PrismaClient, emails: string[]): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  if (!users.length) return;
  await prisma.job.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
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
