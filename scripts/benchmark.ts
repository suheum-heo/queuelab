import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPrismaClient } from '@queuelab/database';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { analyzeCsvStream } from '../apps/worker/src/csv/analyze-file';
import { accessToken } from '../apps/api/src/auth/test-login';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: resolve(repo, '.env') });

const JOBS_PER_RUN = 20;
const WORKER_COUNTS = [1, 2, 4, 8] as const;
const RECOVERY_TRIALS = 3;
const PORT = 3199;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const QUEUE = `csv-analysis-bench-${process.pid}`;
const EMAIL = 'bench-perf@queuelab.dev';

interface JobView {
  id: string;
  status: string;
  progress: number;
  attemptsMade: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobSample {
  id: string;
  submitMs: number;
  queueWaitMs: number;
  processMs: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

interface RunResult {
  workers: number;
  jobs: number;
  makespanMs: number;
  jobsPerMinute: number;
  submit: Percentiles;
  queueWait: Percentiles;
  process: Percentiles;
  samples: JobSample[];
}

interface RecoveryTrial {
  trial: number;
  progressAtKill: number;
  killToStalledMs: number | null;
  killToResumeMs: number | null;
  killToCompletedMs: number;
  redoMs: number;
}

interface Percentiles {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

class BenchFailure extends Error {}

const children: ChildProcess[] = [];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new BenchFailure('DATABASE_URL is not set');
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const webOrigin = (process.env.WEB_ORIGIN ?? 'http://localhost:4200').replace(/\/$/, '');
  const prisma = createPrismaClient(databaseUrl);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  let api: ChildProcess | undefined;
  const uploadKeys: string[] = [];

  try {
    const hardware = await hardwareReport(prisma, redis);
    api = spawnApi(databaseUrl, redisUrl, webOrigin);
    await waitForHealth(api);
    const token = await accessToken(ORIGIN, {
      email: EMAIL,
      redirectUri: `${webOrigin}/api/v1/auth/callback`,
    });
    const file = await chooseFile(token, uploadKeys);
    console.log(
      `file ${file.rows} rows, ${file.bytes} bytes, one job ${file.calibrationMs} ms, sha256 ${file.sha256.slice(0, 12)}`,
    );
    const uploaded = file.uploaded;

    const runs: RunResult[] = [];
    for (const workers of WORKER_COUNTS) {
      const run = await measureRun(prisma, token, uploaded.id, workers);
      runs.push(run);
      console.log(
        `${workers} workers: ${run.jobsPerMinute.toFixed(1)} jobs/min, process p50 ${run.process.p50} ms, queue p50 ${run.queueWait.p50} ms`,
      );
    }

    const recovery: RecoveryTrial[] = [];
    for (let trial = 1; trial <= RECOVERY_TRIALS; trial += 1) {
      const result = await measureRecovery(prisma, token, uploaded.id, trial);
      recovery.push(result);
      console.log(
        `recovery ${trial}: kill to complete ${result.killToCompletedMs} ms (resume ${result.killToResumeMs} ms)`,
      );
    }

    const report = {
      measuredAt: new Date().toISOString(),
      hardware,
      file: {
        rows: file.rows,
        invalidRows: file.invalidRows,
        bytes: file.bytes,
        sha256: file.sha256,
        probeMs: file.probeMs,
        calibrationMs: file.calibrationMs,
      },
      procedure: {
        jobsPerRun: JOBS_PER_RUN,
        workerCounts: WORKER_COUNTS,
        workerConcurrency: 1,
        queue: QUEUE,
        databasePoolMax: { api: 5, worker: 2 },
        stall: { lockDurationMs: 30_000, stalledIntervalMs: 30_000, maxStalledCount: 1 },
        percentile: 'nearest-rank, rank = ceil(p/100 * n)',
      },
      runs,
      recovery,
    };
    mkdirSync(resolve(repo, 'docs'), { recursive: true });
    writeFileSync(resolve(repo, 'docs/benchmarks.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(resolve(repo, 'docs/benchmarks.md'), renderMarkdown(report));
    console.log('wrote docs/benchmarks.md');
  } finally {
    await stopAll();
    if (api) await stopChild(api);
    await cleanup(prisma, redis, uploadKeys).catch((error: unknown) => {
      console.error('cleanup failed', error);
    });
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function chooseFile(
  token: string,
  uploadKeys: string[],
): Promise<{
  rows: number;
  invalidRows: number;
  bytes: number;
  sha256: string;
  probeMs: number;
  calibrationMs: number;
  uploaded: { id: string; key: string };
}> {
  let rows = 80_000;
  let selected:
    | {
        rows: number;
        invalidRows: number;
        bytes: number;
        sha256: string;
        probeMs: number;
        calibrationMs: number;
        uploaded: { id: string; key: string };
      }
    | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body = generateCsv(rows);
    if (body.length > 8 * 1024 * 1024) break;
    const probeStarted = Date.now();
    await analyzeCsvStream(Readable.from(body), body.length, { delimiter: ',', hasHeader: true }, async () => undefined);
    const probeMs = Date.now() - probeStarted;
    const uploaded = await upload(token, body);
    uploadKeys.push(uploaded.key);
    const worker = startWorkers(1)[0];
    if (!worker) throw new BenchFailure('Calibration worker did not start');
    const calibrationMs = await (async () => {
      try {
        await waitForLog(worker, 'listening', 20_000);
        const submitted = await submitJob(token, uploaded.id);
        const view = await waitForOne(token, submitted.id, 120_000);
        if (view.status !== 'COMPLETED' || !view.startedAt || !view.finishedAt) {
          throw new BenchFailure(`Calibration job finished as ${view.status}: ${view.errorMessage ?? ''}`);
        }
        return Date.parse(view.finishedAt) - Date.parse(view.startedAt);
      } finally {
        await stopChild(worker);
      }
    })();
    const dataRows = countRows(body);
    selected = {
      rows: dataRows,
      invalidRows: invalidCount(dataRows),
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      probeMs,
      calibrationMs,
      uploaded,
    };
    console.log(`calibration ${dataRows} rows: parse ${probeMs} ms, job ${calibrationMs} ms`);
    if (calibrationMs >= 2_000 && calibrationMs <= 7_000) break;
    const scaled = Math.round((rows * 4_000) / Math.max(calibrationMs, 1));
    const next = Math.min(280_000, Math.max(10_000, scaled));
    if (next === rows || body.length > 6 * 1024 * 1024) break;
    rows = next;
  }
  if (!selected) throw new BenchFailure('Could not build a CSV fixture');
  return selected;
}

function generateCsv(rows: number): Buffer {
  const lines = ['order_id,sku,quantity,amount'];
  for (let i = 1; i <= rows; i += 1) {
    const invalid = i % 50 === 0;
    const quantity = invalid ? 'x' : String((i % 5) + 1);
    const amount = (((i * 37) % 9_999) + 1) / 100;
    lines.push(
      `${String(10_000_000 + i)},SKU-${String((i % 200) + 1).padStart(4, '0')},${quantity},${amount.toFixed(2)}`,
    );
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

function countRows(body: Buffer): number {
  return body.toString('utf8').split('\n').filter((line) => line.length > 0).length - 1;
}

function invalidCount(rows: number): number {
  return Math.floor(rows / 50);
}

async function measureRun(
  prisma: ReturnType<typeof createPrismaClient>,
  token: string,
  fileId: string,
  workers: number,
): Promise<RunResult> {
  const group = startWorkers(workers);
  try {
    await Promise.all(group.map((child) => waitForLog(child, 'listening', 20_000)));
    const submitted: { id: string; submitMs: number }[] = [];
    for (let index = 0; index < JOBS_PER_RUN; index += 1) {
      submitted.push(await submitJob(token, fileId));
    }
    const views = await waitForTerminal(
      token,
      submitted.map((job) => job.id),
      12 * 60_000,
    );
    const samples: JobSample[] = [];
    for (const item of submitted) {
      const view = views.get(item.id);
      if (!view || view.status !== 'COMPLETED' || !view.startedAt || !view.finishedAt) {
        throw new BenchFailure(`Job ${item.id} finished as ${view?.status ?? 'missing'}: ${view?.errorMessage ?? ''}`);
      }
      const queued = await prisma.jobEvent.findFirst({
        where: { jobId: item.id, eventType: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
      });
      if (!queued) throw new BenchFailure(`Job ${item.id} has no QUEUED event`);
      const stalled = await prisma.jobEvent.count({ where: { jobId: item.id, eventType: 'STALLED' } });
      if (stalled > 0) throw new BenchFailure(`Job ${item.id} stalled during a throughput run`);
      samples.push({
        id: item.id,
        submitMs: item.submitMs,
        queueWaitMs: Date.parse(view.startedAt) - queued.createdAt.getTime(),
        processMs: Date.parse(view.finishedAt) - Date.parse(view.startedAt),
        createdAt: view.createdAt,
        startedAt: view.startedAt,
        finishedAt: view.finishedAt,
      });
    }
    const created = samples.map((sample) => Date.parse(sample.createdAt));
    const finished = samples.map((sample) => Date.parse(sample.finishedAt));
    const makespanMs = Math.max(...finished) - Math.min(...created);
    return {
      workers,
      jobs: samples.length,
      makespanMs,
      jobsPerMinute: samples.length / (makespanMs / 60_000),
      submit: percentiles(samples.map((sample) => sample.submitMs)),
      queueWait: percentiles(samples.map((sample) => sample.queueWaitMs)),
      process: percentiles(samples.map((sample) => sample.processMs)),
      samples,
    };
  } finally {
    await Promise.all(group.map((child) => stopChild(child)));
  }
}

async function measureRecovery(
  prisma: ReturnType<typeof createPrismaClient>,
  token: string,
  fileId: string,
  trial: number,
): Promise<RecoveryTrial> {
  const victim = startWorkers(1)[0];
  if (!victim) throw new BenchFailure('Recovery worker did not start');
  let replacement: ChildProcess | undefined;
  try {
    await waitForLog(victim, 'listening', 20_000);
    const submitted = await submitJob(token, fileId);
    const kill = await killWhileProcessing(token, victim, submitted.id);
    replacement = startWorkers(1)[0];
    if (!replacement) throw new BenchFailure('Replacement worker did not start');
    await waitForLog(replacement, 'listening', 20_000);
    const view = await waitForOne(token, submitted.id, 180_000);
    if (view.status !== 'COMPLETED' || !view.finishedAt) {
      throw new BenchFailure(`Recovery trial ${trial} finished as ${view.status}: ${view.errorMessage ?? ''}`);
    }
    const events = await prisma.jobEvent.findMany({
      where: { jobId: submitted.id },
      orderBy: { createdAt: 'asc' },
    });
    const stalled = events.find((event) => event.eventType === 'STALLED');
    const processing = events.filter((event) => event.eventType === 'PROCESSING');
    const resumed = processing[1];
    if (!resumed) throw new BenchFailure(`Recovery trial ${trial} never resumed`);
    return {
      trial,
      progressAtKill: kill.progress,
      killToStalledMs: stalled ? stalled.createdAt.getTime() - kill.at : null,
      killToResumeMs: resumed.createdAt.getTime() - kill.at,
      killToCompletedMs: Date.parse(view.finishedAt) - kill.at,
      redoMs: Date.parse(view.finishedAt) - resumed.createdAt.getTime(),
    };
  } finally {
    if (replacement) await stopChild(replacement);
    await stopChild(victim);
  }
}

function startWorkers(count: number): ChildProcess[] {
  return Array.from({ length: count }, (_, index) => {
    const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
      cwd: repo,
      env: childEnv({ WORKER_CONCURRENCY: '1', DATABASE_POOL_MAX: '2', BENCH_WORKER: String(index + 1) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watch(child, `worker-${index + 1}`);
    children.push(child);
    return child;
  });
}

function spawnApi(databaseUrl: string, redisUrl: string, webOrigin: string): ChildProcess {
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: repo,
    env: childEnv({
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      WEB_ORIGIN: webOrigin,
      DATABASE_POOL_MAX: '5',
      OIDC_ISSUER: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  watch(child, 'api');
  children.push(child);
  return child;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    CSV_ANALYSIS_QUEUE: QUEUE,
    ...extra,
  };
}

function watch(child: ChildProcess, name: string): void {
  const keep = (chunk: Buffer) => {
    const text = chunk.toString();
    child.benchLog = `${child.benchLog ?? ''}${text}`.slice(-12_000);
    if (text.includes('Error') || text.includes('error')) {
      process.stderr.write(`[${name}] ${text}`);
    }
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('exit', (code, signal) => {
    if (!child.benchExpectedExit && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      console.error(`[${name}] exited code ${code} signal ${signal}`);
    }
  });
}

async function waitForHealth(api: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new BenchFailure(`API exited before health: ${api.benchLog ?? ''}`);
    try {
      const response = await fetch(`${ORIGIN}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // The process is still binding the port.
    }
    await delay(200);
  }
  throw new BenchFailure(`API did not become healthy: ${api.benchLog ?? ''}`);
}

async function waitForLog(child: ChildProcess, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new BenchFailure(`Process exited before ${text}: ${child.benchLog ?? ''}`);
    }
    if ((child.benchLog ?? '').includes(text)) return;
    await delay(50);
  }
  throw new BenchFailure(`Timed out waiting for ${text}: ${child.benchLog ?? ''}`);
}

async function upload(token: string, body: Buffer): Promise<{ id: string; key: string }> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(body)], { type: 'text/csv' }), 'orders.csv');
  const response = await fetch(`${ORIGIN}/api/v1/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new BenchFailure(`Upload failed ${response.status} ${text}`);
  const parsed = JSON.parse(text) as { id?: string; key?: string };
  if (!parsed.id || !parsed.key) throw new BenchFailure(`Upload response was incomplete: ${text}`);
  return { id: parsed.id, key: parsed.key };
}

async function submitJob(token: string, fileId: string): Promise<{ id: string; submitMs: number }> {
  const started = Date.now();
  const response = await fetch(`${ORIGIN}/api/v1/jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'CSV_ANALYSIS', fileId }),
  });
  const text = await response.text();
  const submitMs = Date.now() - started;
  if (response.status !== 202) throw new BenchFailure(`Submit failed ${response.status} ${text}`);
  const parsed = JSON.parse(text) as { id?: string };
  if (!parsed.id) throw new BenchFailure(`Submit response was incomplete: ${text}`);
  return { id: parsed.id, submitMs };
}

async function waitForTerminal(token: string, ids: string[], timeoutMs: number): Promise<Map<string, JobView>> {
  const deadline = Date.now() + timeoutMs;
  const done = new Map<string, JobView>();
  while (Date.now() < deadline) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const view = await getJob(token, id);
      if (view.status === 'COMPLETED' || view.status === 'FAILED') done.set(id, view);
    }
    if (done.size === ids.length) return done;
    await delay(200);
  }
  throw new BenchFailure(`Timed out with ${done.size} of ${ids.length} jobs finished`);
}

async function killWhileProcessing(
  token: string,
  victim: ChildProcess,
  id: string,
): Promise<{ at: number; progress: number }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const view = await getJob(token, id);
    if (view.status === 'FAILED') throw new BenchFailure(`Job failed before the kill: ${view.errorMessage ?? ''}`);
    if (view.status === 'COMPLETED') throw new BenchFailure('Job finished before it could be killed');
    if (view.status === 'PROCESSING' && view.progress >= 20 && victim.pid) {
      const at = Date.now();
      victim.benchExpectedExit = true;
      process.kill(victim.pid, 'SIGKILL');
      await exited(victim, 2_000);
      return { at, progress: view.progress };
    }
    await delay(40);
  }
  throw new BenchFailure('Job did not reach 20% before the kill window closed');
}

async function waitForOne(token: string, id: string, timeoutMs: number): Promise<JobView> {
  const views = await waitForTerminal(token, [id], timeoutMs);
  const view = views.get(id);
  if (!view) throw new BenchFailure(`Missing job ${id}`);
  return view;
}

async function getJob(token: string, id: string): Promise<JobView> {
  const response = await fetch(`${ORIGIN}/api/v1/jobs/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new BenchFailure(`Job read failed ${response.status} ${text}`);
  return JSON.parse(text) as JobView;
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: rank(sorted, 50),
    p95: rank(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function rank(sorted: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
}

async function hardwareReport(
  prisma: ReturnType<typeof createPrismaClient>,
  redis: Redis,
): Promise<Record<string, string | number>> {
  const [postgres] = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  const [settings] = await prisma.$queryRaw<Array<{ max: string; active: bigint }>>`
    SELECT current_setting('max_connections') AS max, count(*)::bigint AS active FROM pg_stat_activity
  `;
  const info = await redis.info('server');
  const redisVersion = /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? 'unknown';
  let cpu = cpus()[0]?.model ?? 'unknown';
  try {
    cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();
  } catch {
    // os.cpus() is the fallback already stored.
  }
  return {
    cpu,
    logicalCpus: availableParallelism(),
    memoryBytes: totalmem(),
    loadAtStart: loadavg()[0] ?? 0,
    node: process.version,
    platform: `${process.platform} ${execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim()}`,
    postgres: (postgres?.version ?? 'unknown').split(',')[0] ?? 'unknown',
    postgresMaxConnections: settings?.max ?? 'unknown',
    postgresSessionsAtStart: Number(settings?.active ?? 0),
    redis: redisVersion,
  };
}

async function cleanup(
  prisma: ReturnType<typeof createPrismaClient>,
  redis: Redis,
  uploadKeys: string[],
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  const reportKeys: string[] = [];
  if (user) {
    const jobs = await prisma.job.findMany({
      where: { userId: user.id },
      select: { resultKey: true },
    });
    for (const job of jobs) {
      if (job.resultKey) reportKeys.push(job.resultKey);
    }
    await prisma.jobResult.deleteMany({ where: { job: { userId: user.id } } });
    await prisma.jobEvent.deleteMany({ where: { job: { userId: user.id } } });
    await prisma.jobExecution.deleteMany({ where: { job: { userId: user.id } } });
    await prisma.job.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  const { rm } = await import('node:fs/promises');
  const storage = process.env.STORAGE_PATH
    ? resolve(repo, process.env.STORAGE_PATH)
    : resolve(repo, 'storage');
  const keys = [
    ...uploadKeys.flatMap((key) => [key, key.replace(/\.csv$/, '.json')]),
    ...reportKeys,
  ].filter(Boolean);
  for (const key of keys) {
    await rm(resolve(storage, key), { force: true });
  }
  const queue = new Queue(QUEUE, { connection: redis });
  await queue.obliterate({ force: true });
  await queue.close();
}

function renderMarkdown(report: {
  measuredAt: string;
  hardware: Record<string, string | number>;
  file: { rows: number; invalidRows: number; bytes: number; sha256: string; probeMs: number; calibrationMs: number };
  procedure: {
    jobsPerRun: number;
    workerConcurrency: number;
    queue: string;
    databasePoolMax: { api: number; worker: number };
    stall: { lockDurationMs: number; stalledIntervalMs: number; maxStalledCount: number };
    percentile: string;
  };
  runs: RunResult[];
  recovery: RecoveryTrial[];
}): string {
  const memoryGiB = (Number(report.hardware.memoryBytes) / 1024 ** 3).toFixed(0);
  const runRows = report.runs
    .map(
      (run) =>
        `| ${run.workers} | ${run.jobsPerMinute.toFixed(1)} | ${(run.makespanMs / 1000).toFixed(1)} | ${run.submit.p50} | ${run.submit.p95} | ${run.queueWait.p50} | ${run.queueWait.p95} | ${run.process.p50} | ${run.process.p95} |`,
    )
    .join('\n');
  const recoveryRows = report.recovery
    .map(
      (trial) =>
        `| ${trial.trial} | ${trial.progressAtKill}% | ${trial.killToStalledMs ?? 'n/a'} | ${trial.killToResumeMs ?? 'n/a'} | ${trial.redoMs} | ${trial.killToCompletedMs} |`,
    )
    .join('\n');
  const one = report.runs[0];
  const fastest = report.runs.reduce((best, run) => (run.jobsPerMinute > best.jobsPerMinute ? run : best));
  return `# QueueLab performance

Measured ${report.measuredAt} on one machine. Every run used the same CSV, the same local PostgreSQL and Redis, and a freshly started API. The public Render services were not running.

## Hardware

| | |
| --- | --- |
| CPU | ${report.hardware.cpu} (${report.hardware.logicalCpus} logical) |
| Memory | ${memoryGiB} GiB |
| OS | ${report.hardware.platform} |
| Node | ${report.hardware.node} |
| PostgreSQL | ${report.hardware.postgres} |
| Redis | ${report.hardware.redis} |
| Load average at start | ${Number(report.hardware.loadAtStart).toFixed(2)} |
| Postgres sessions already open | ${report.hardware.postgresSessionsAtStart} of ${report.hardware.postgresMaxConnections} |

## Fixture

One generated file was uploaded once and reused for every job.

| | |
| --- | --- |
| Data rows | ${report.file.rows.toLocaleString('en-US')} |
| Invalid rows | ${report.file.invalidRows.toLocaleString('en-US')} (every 50th quantity is \`x\`) |
| Size | ${report.file.bytes.toLocaleString('en-US')} bytes |
| SHA-256 | \`${report.file.sha256}\` |
| Stream parse, no database | ${report.file.probeMs} ms |
| One full job, excluded from the tables | ${report.file.calibrationMs} ms |

Columns are \`order_id\`, \`sku\`, \`quantity\`, and \`amount\`. The generator is in \`scripts/benchmark.ts\`. Row ${'`'}i${'`'} is invalid when ${'`'}i % 50 === 0${'`'}.

## How the numbers were taken

- ${report.procedure.jobsPerRun} jobs per concurrency level. Requests were sent one at a time to \`POST /api/v1/jobs\` on a local API at port ${PORT}.
- Worker counts were ${report.runs.map((run) => run.workers).join(', ')} operating-system processes. Each process had \`WORKER_CONCURRENCY=${report.procedure.workerConcurrency}\`.
- The queue name was \`${report.procedure.queue}\`, so the development worker on \`csv-analysis\` did not take these jobs.
- Each API process used at most ${report.procedure.databasePoolMax.api} Postgres connections, and each worker at most ${report.procedure.databasePoolMax.worker}, so eight workers fit under the local connection cap.
- Submission latency is the client time for the 202 response.
- Queue wait is \`startedAt\` minus the \`QUEUED\` event time. Both come from PostgreSQL.
- Processing time is \`finishedAt - startedAt\`. It includes the stream, the progress writes, the report write, and the completion transaction. None of these jobs stalled.
- Throughput is ${report.procedure.jobsPerRun} divided by the time from the first job's \`createdAt\` to the last job's \`finishedAt\`.
- Percentiles use ${report.procedure.percentile}. With ${report.procedure.jobsPerRun} samples, p95 is the ${Math.ceil(0.95 * report.procedure.jobsPerRun)}th sorted value.
- Recovery used the production stall settings: lock ${report.procedure.stall.lockDurationMs} ms, check every ${report.procedure.stall.stalledIntervalMs} ms, and at most ${report.procedure.stall.maxStalledCount} stall. The worker was \`SIGKILL\`ed once progress reached at least 20%. A replacement process was started as soon as the killed process exited. The clock starts at the kill.

## Results

| Workers | Jobs/min | Makespan (s) | Submit p50 (ms) | Submit p95 (ms) | Queue p50 (ms) | Queue p95 (ms) | Process p50 (ms) | Process p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${runRows}

One worker completed ${one ? one.jobsPerMinute.toFixed(1) : 'n/a'} jobs per minute. ${fastest.workers} workers completed ${fastest.jobsPerMinute.toFixed(1)}.

### Recovery

| Trial | Progress at kill | Kill to stall event (ms) | Kill to resume (ms) | Redo the file (ms) | Kill to completed (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
${recoveryRows}

The resumed execution reads the CSV from the first row. \`startedAt\` is not reset, so the redo column is the time from the second \`PROCESSING\` event to \`finishedAt\`, and the last column is the whole gap the caller waits through.

Raw samples are in [benchmarks.json](benchmarks.json). Run \`pnpm bench\` to repeat this on the same fixture rules.
`;
}

async function stopAll(): Promise<void> {
  await Promise.all(children.map((child) => stopChild(child)));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  child.benchExpectedExit = true;
  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  const stopped = await exited(child, 5_000);
  if (!stopped && child.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      return;
    }
    await exited(child, 2_000);
  }
}

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

declare global {
  interface ChildProcess {
    benchLog?: string;
    benchExpectedExit?: boolean;
  }
}

void main().catch(async (error: unknown) => {
  console.error(error);
  await stopAll();
  process.exitCode = 1;
});
