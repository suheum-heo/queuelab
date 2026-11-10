import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  DEFAULT_MAX_ATTEMPTS,
  resolveCsvAnalysisQueue,
  type CsvAnalysisPayload,
} from '@queuelab/shared-types';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly pingConnection: Redis;
  private readonly queueName: string;
  private readonly queue: Queue<CsvAnalysisPayload>;

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.queueName = resolveCsvAnalysisQueue();
    this.connection = new Redis(url, { maxRetriesPerRequest: null });
    this.pingConnection = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      enableOfflineQueue: false,
    });
    this.queue = new Queue(this.queueName, { connection: this.connection });
  }

  async enqueueCsvAnalysis(payload: CsvAnalysisPayload): Promise<void> {
    await enqueueExecution(this.queue, this.queueName, payload);
  }

  /** The reconciler inspects this queue. The connection stays owned by the service. */
  executionQueue(): Queue<CsvAnalysisPayload> {
    return this.queue;
  }

  async ping(): Promise<void> {
    const result = await this.pingConnection.ping();
    if (result !== 'PONG') {
      throw new Error('Redis did not respond to ping');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
    this.pingConnection.disconnect();
  }
}

export const EXECUTION_JOB_OPTIONS = {
  attempts: DEFAULT_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
};

/** Adding an execution that is already in Redis is success. The id is not minted again. */
export async function enqueueExecution(
  queue: Queue<CsvAnalysisPayload>,
  queueName: string,
  payload: CsvAnalysisPayload,
): Promise<'added' | 'present'> {
  const existing = await queue.getJob(payload.executionId);
  if (existing) return 'present';
  try {
    await queue.add(queueName, payload, {
      ...EXECUTION_JOB_OPTIONS,
      jobId: payload.executionId,
    });
    return 'added';
  } catch (error) {
    const raced = await queue.getJob(payload.executionId);
    if (raced) return 'present';
    throw error;
  }
}
