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
  private readonly queue: Queue;

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
    await this.queue.add(this.queueName, payload, {
      jobId: payload.executionId,
      attempts: DEFAULT_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    });
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
