import type { PrismaClient } from '@queuelab/database';
import type { CsvAnalysisOptions, CsvAnalysisPayload } from '@queuelab/shared-types';
import { Queue } from 'bullmq';
import { enqueueExecution } from '../queue/queue.service';

export const DEFAULT_PENDING_MIN_AGE_MS = 15_000;
export const DEFAULT_STUCK_AFTER_MS = 120_000;
export const DEFAULT_CLAIM_LEASE_MS = 20_000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;

const ACTIVE = ['QUEUED', 'PROCESSING', 'RETRYING'] as const;

export interface ReconcileOptions {
  minPendingAgeMs: number;
  stuckAfterMs: number;
  claimLeaseMs: number;
  now?: Date;
  /** Limits a run to these ledger ids. The scheduler omits it and scans the table. */
  jobIds?: string[];
}

export interface ReconcileSummary {
  pendingRecovered: number;
  queueRestored: number;
  failuresSynced: number;
  completionsRepaired: number;
  stuck: number;
}

type Publish = (jobId: string, eventType: string) => Promise<void>;

type QueueKind =
  | { kind: 'missing' }
  | { kind: 'in-queue' }
  | { kind: 'failed'; reason: string }
  | { kind: 'completed' };

interface Claimed {
  job: {
    id: string;
    status: string;
    inputKey: string | null;
    options: unknown;
    executionNumber: number;
    currentExecutionId: string | null;
    startedAt: Date | null;
    createdAt: Date;
  };
  execution: {
    id: string;
    number: number;
    createdAt: Date;
    startedAt: Date | null;
  };
  claimedAt: Date;
}

/**
 * Pending rows are executions the API saved and then failed to hand to Redis,
 * or handed to Redis and then died before marking them queued.
 * The claim is a conditional update, so two reconcilers cannot both enqueue.
 * BullMQ still owns stalled workers. This pass only repairs rows whose queue
 * record is missing, already failed, or completed without the ledger noticing.
 */
export async function reconcileJobs(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  publish: Publish,
  options: ReconcileOptions,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    pendingRecovered: 0,
    queueRestored: 0,
    failuresSynced: 0,
    completionsRepaired: 0,
    stuck: 0,
  };
  const now = options.now ?? new Date();
  await reconcilePending(prisma, queue, publish, options, summary, now);
  await reconcileDrift(prisma, queue, publish, options, summary, now);
  return summary;
}

async function reconcilePending(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  publish: Publish,
  options: ReconcileOptions,
  summary: ReconcileSummary,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - options.minPendingAgeMs);
  const executions = await prisma.jobExecution.findMany({
    where: {
      status: 'PENDING_ENQUEUE',
      createdAt: { lte: cutoff },
      job: {
        status: 'PENDING_ENQUEUE',
        currentExecutionId: { not: null },
        ...(options.jobIds ? { id: { in: options.jobIds } } : {}),
      },
    },
    include: { job: true },
    orderBy: { createdAt: 'asc' },
    take: 25,
  });

  for (const execution of executions) {
    if (execution.job.currentExecutionId !== execution.id) continue;
    const claimed = await claim(prisma, execution.job, execution, options.claimLeaseMs, now);
    if (!claimed) continue;
    const outcome = await recover(prisma, queue, publish, claimed);
    if (outcome === 'queued') summary.pendingRecovered += 1;
    else if (outcome === 'failed') summary.failuresSynced += 1;
    else if (outcome === 'completed') summary.completionsRepaired += 1;
    else if (outcome === 'stuck') summary.stuck += 1;
  }
}

async function reconcileDrift(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  publish: Publish,
  options: ReconcileOptions,
  summary: ReconcileSummary,
  now: Date,
): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: [...ACTIVE] },
      currentExecutionId: { not: null },
      ...(options.jobIds ? { id: { in: options.jobIds } } : {}),
    },
    include: { executions: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  for (const job of jobs) {
    const execution = job.executions.find((item) => item.id === job.currentExecutionId);
    if (!execution) continue;
    if (ageMs(job, execution, now) < options.stuckAfterMs) continue;
    const observed = await inspect(queue, execution.id);
    if (observed.kind === 'in-queue') continue;

    const claimed = await claim(prisma, job, execution, options.claimLeaseMs, now);
    if (!claimed) continue;
    const outcome = await recover(prisma, queue, publish, claimed);
    if (outcome === 'restored') summary.queueRestored += 1;
    else if (outcome === 'failed') summary.failuresSynced += 1;
    else if (outcome === 'completed') summary.completionsRepaired += 1;
    else if (outcome === 'stuck') summary.stuck += 1;
  }
}

async function recover(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  publish: Publish,
  claimed: Claimed,
): Promise<'queued' | 'restored' | 'failed' | 'completed' | 'stuck' | 'released'> {
  const state = await inspect(queue, claimed.execution.id);
  if (state.kind === 'in-queue') {
    if (claimed.job.status === 'PENDING_ENQUEUE') {
      const marked = await markQueued(prisma, publish, claimed, 'already in BullMQ');
      return marked ? 'queued' : 'released';
    }
    await release(prisma, claimed);
    return 'released';
  }

  if (state.kind === 'failed') {
    const marked = await markFailedFromQueue(prisma, publish, claimed, state.reason);
    return marked ? 'failed' : 'released';
  }

  if (state.kind === 'completed') {
    return repairCompleted(prisma, queue, publish, claimed);
  }

  const payload = payloadFor(claimed);
  if (!payload) {
    await markStuck(prisma, publish, claimed, 'the stored options or CSV path is missing');
    await release(prisma, claimed);
    return 'stuck';
  }

  try {
    await enqueueExecution(queue, queue.name, payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    await markEnqueueFailed(prisma, publish, claimed, reason);
    return 'stuck';
  }

  if (claimed.job.status === 'PENDING_ENQUEUE') {
    const marked = await markQueued(prisma, publish, claimed, 'missing from BullMQ');
    return marked ? 'queued' : 'released';
  }

  const marked = await markRestored(prisma, publish, claimed);
  return marked ? 'restored' : 'released';
}

async function repairCompleted(
  prisma: PrismaClient,
  queue: Queue<CsvAnalysisPayload>,
  publish: Publish,
  claimed: Claimed,
): Promise<'completed' | 'restored' | 'stuck' | 'released'> {
  const result = await prisma.jobResult.findUnique({ where: { jobId: claimed.job.id } });
  if (result?.executionId === claimed.execution.id) {
    const marked = await markCompleted(prisma, publish, claimed);
    return marked ? 'completed' : 'released';
  }

  const bullJob = await queue.getJob(claimed.execution.id);
  if (bullJob) {
    try {
      await bullJob.remove();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      await markStuck(prisma, publish, claimed, `BullMQ completed it without a result and it could not be removed (${reason})`);
      await release(prisma, claimed);
      return 'stuck';
    }
  }

  const payload = payloadFor(claimed);
  if (!payload) {
    await markStuck(prisma, publish, claimed, 'BullMQ completed it without a result or a stored CSV');
    await release(prisma, claimed);
    return 'stuck';
  }

  try {
    await enqueueExecution(queue, queue.name, payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    await markStuck(prisma, publish, claimed, `BullMQ completed it without a result and the requeue failed (${reason})`);
    await release(prisma, claimed);
    return 'stuck';
  }

  const marked = await markRestored(prisma, publish, claimed);
  return marked ? 'restored' : 'released';
}

async function inspect(queue: Queue<CsvAnalysisPayload>, executionId: string): Promise<QueueKind> {
  const bullJob = await queue.getJob(executionId);
  if (!bullJob) return { kind: 'missing' };
  const state = await bullJob.getState();
  if (state === 'failed') {
    return { kind: 'failed', reason: bullJob.failedReason || 'BullMQ marked the execution failed' };
  }
  if (state === 'completed') return { kind: 'completed' };
  return { kind: 'in-queue' };
}

async function claim(
  prisma: PrismaClient,
  job: Claimed['job'],
  execution: Claimed['execution'],
  leaseMs: number,
  now: Date,
): Promise<Claimed | null> {
  const claimedAt = new Date();
  const leaseStart = new Date(now.getTime() - leaseMs);
  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      status: job.status as 'PENDING_ENQUEUE',
      currentExecutionId: execution.id,
      OR: [{ enqueueClaimedAt: null }, { enqueueClaimedAt: { lt: leaseStart } }],
    },
    data: { enqueueClaimedAt: claimedAt },
  });
  if (updated.count !== 1) return null;
  return { job, execution, claimedAt };
}

async function release(prisma: PrismaClient, claimed: Claimed): Promise<void> {
  await prisma.job.updateMany({
    where: {
      id: claimed.job.id,
      currentExecutionId: claimed.execution.id,
      enqueueClaimedAt: claimed.claimedAt,
    },
    data: { enqueueClaimedAt: null },
  });
}

async function markQueued(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
  how: string,
): Promise<boolean> {
  const wrote = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: {
        id: claimed.job.id,
        status: 'PENDING_ENQUEUE',
        currentExecutionId: claimed.execution.id,
        enqueueClaimedAt: claimed.claimedAt,
      },
      data: { status: 'QUEUED', enqueueClaimedAt: null },
    });
    if (updated.count !== 1) return false;
    await tx.jobExecution.update({
      where: { id: claimed.execution.id },
      data: { status: 'QUEUED' },
    });
    await tx.jobEvent.create({
      data: {
        jobId: claimed.job.id,
        eventType: 'ENQUEUE_RECOVERED',
        message: `Reconciler queued execution ${claimed.execution.number} (${how}). The same execution id was kept.`,
        metadata: {
          executionId: claimed.execution.id,
          executionNumber: claimed.execution.number,
        },
      },
    });
    return true;
  });
  if (wrote) await safePublish(publish, claimed.job.id, 'ENQUEUE_RECOVERED');
  else await release(prisma, claimed);
  return wrote;
}

async function markRestored(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
): Promise<boolean> {
  const wrote = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: {
        id: claimed.job.id,
        status: claimed.job.status as 'QUEUED',
        currentExecutionId: claimed.execution.id,
        enqueueClaimedAt: claimed.claimedAt,
      },
      data: { status: 'QUEUED', enqueueClaimedAt: null, finishedAt: null },
    });
    if (updated.count !== 1) return false;
    await tx.jobExecution.update({
      where: { id: claimed.execution.id },
      data: { status: 'QUEUED', finishedAt: null },
    });
    await tx.jobEvent.create({
      data: {
        jobId: claimed.job.id,
        eventType: 'QUEUE_RECOVERED',
        message: `Execution ${claimed.execution.number} was missing from BullMQ while the ledger said ${claimed.job.status}. The same execution was queued again.`,
        metadata: {
          executionId: claimed.execution.id,
          executionNumber: claimed.execution.number,
          previousStatus: claimed.job.status,
        },
      },
    });
    return true;
  });
  if (wrote) await safePublish(publish, claimed.job.id, 'QUEUE_RECOVERED');
  else await release(prisma, claimed);
  return wrote;
}

async function markFailedFromQueue(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
  reason: string,
): Promise<boolean> {
  const wrote = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: {
        id: claimed.job.id,
        status: claimed.job.status as 'PROCESSING',
        currentExecutionId: claimed.execution.id,
        enqueueClaimedAt: claimed.claimedAt,
      },
      data: {
        status: 'FAILED',
        errorMessage: reason,
        finishedAt: new Date(),
        enqueueClaimedAt: null,
      },
    });
    if (updated.count !== 1) return false;
    await tx.jobExecution.update({
      where: { id: claimed.execution.id },
      data: { status: 'FAILED', errorMessage: reason, finishedAt: new Date() },
    });
    await tx.jobEvent.create({
      data: {
        jobId: claimed.job.id,
        eventType: 'FAILED',
        message: `Execution ${claimed.execution.number} had already failed in BullMQ (${reason}). The ledger was updated and was not queued again.`,
        metadata: {
          executionId: claimed.execution.id,
          executionNumber: claimed.execution.number,
          reason,
        },
      },
    });
    return true;
  });
  if (wrote) await safePublish(publish, claimed.job.id, 'FAILED');
  else await release(prisma, claimed);
  return wrote;
}

async function markCompleted(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
): Promise<boolean> {
  const wrote = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({
      where: {
        id: claimed.job.id,
        status: claimed.job.status as 'PROCESSING',
        currentExecutionId: claimed.execution.id,
        enqueueClaimedAt: claimed.claimedAt,
      },
      data: {
        status: 'COMPLETED',
        progress: 100,
        finishedAt: new Date(),
        errorMessage: null,
        enqueueClaimedAt: null,
      },
    });
    if (updated.count !== 1) return false;
    await tx.jobExecution.update({
      where: { id: claimed.execution.id },
      data: { status: 'COMPLETED', finishedAt: new Date(), errorMessage: null },
    });
    await tx.jobEvent.create({
      data: {
        jobId: claimed.job.id,
        eventType: 'RECOVERED',
        message: `Execution ${claimed.execution.number} already had one stored result. The ledger was marked completed.`,
        metadata: {
          executionId: claimed.execution.id,
          executionNumber: claimed.execution.number,
        },
      },
    });
    return true;
  });
  if (wrote) await safePublish(publish, claimed.job.id, 'RECOVERED');
  else await release(prisma, claimed);
  return wrote;
}

async function markEnqueueFailed(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
  reason: string,
): Promise<void> {
  await prisma.jobEvent.create({
    data: {
      jobId: claimed.job.id,
      eventType: 'ENQUEUE_FAILED',
      message: `Reconciler could not queue execution ${claimed.execution.number}. ${reason}`,
      metadata: { executionId: claimed.execution.id, reason },
    },
  });
  await safePublish(publish, claimed.job.id, 'ENQUEUE_FAILED');
}

async function markStuck(
  prisma: PrismaClient,
  publish: Publish,
  claimed: Claimed,
  reason: string,
): Promise<void> {
  const recent = await prisma.jobEvent.findFirst({
    where: { jobId: claimed.job.id, eventType: 'STUCK' },
    orderBy: { createdAt: 'desc' },
  });
  if (recent && Date.now() - recent.createdAt.getTime() < 60_000) return;
  await prisma.jobEvent.create({
    data: {
      jobId: claimed.job.id,
      eventType: 'STUCK',
      message: `Execution ${claimed.execution.number} cannot make progress: ${reason}`,
      metadata: { executionId: claimed.execution.id, reason },
    },
  });
  await safePublish(publish, claimed.job.id, 'STUCK');
}

function payloadFor(claimed: Claimed): CsvAnalysisPayload | null {
  if (!claimed.job.inputKey) return null;
  const options = readOptions(claimed.job.options);
  if (!options) return null;
  return {
    jobId: claimed.job.id,
    executionId: claimed.execution.id,
    fileKey: claimed.job.inputKey,
    options,
  };
}

function readOptions(value: unknown): CsvAnalysisOptions | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CsvAnalysisOptions>;
  if (typeof record.delimiter !== 'string' || typeof record.filename !== 'string') return null;
  if (record.seeded) return null;
  return {
    delimiter: record.delimiter,
    hasHeader: record.hasHeader ?? true,
    filename: record.filename,
    ...(record.demoFailure ? { demoFailure: record.demoFailure } : {}),
    ...(record.crashAt ? { crashAt: record.crashAt } : {}),
    ...(record.fault ? { fault: record.fault } : {}),
  };
}

function ageMs(
  job: { status: string; startedAt: Date | null; createdAt: Date },
  execution: { createdAt: Date; startedAt: Date | null },
  now: Date,
): number {
  const anchor =
    job.status === 'QUEUED' ? execution.createdAt : (execution.startedAt ?? job.startedAt ?? execution.createdAt);
  return now.getTime() - anchor.getTime();
}

async function safePublish(publish: Publish, jobId: string, eventType: string): Promise<void> {
  try {
    await publish(jobId, eventType);
  } catch {
    // The ledger write already committed. A missed notice is reread on reconnect.
  }
}
