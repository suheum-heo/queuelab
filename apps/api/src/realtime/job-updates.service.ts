import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JOB_UPDATES_CHANNEL, readJobUpdateNotice, type JobUpdateNotice } from '@queuelab/shared-types';
import { Redis } from 'ioredis';
import { JobsGateway } from './jobs.gateway';

@Injectable()
export class JobUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobUpdatesService.name);
  private publisher?: Redis;
  private subscriber?: Redis;

  constructor(private readonly gateway: JobsGateway) {}

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.publisher = new Redis(url, { maxRetriesPerRequest: 2 });
    this.subscriber = new Redis(url, { maxRetriesPerRequest: null });
    await this.subscriber.subscribe(JOB_UPDATES_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== JOB_UPDATES_CHANNEL) return;
      const notice = readJobUpdateNotice(message);
      if (!notice) {
        this.logger.warn('Ignored a job notice that did not identify a job');
        return;
      }
      this.gateway.emit(notice);
    });
  }

  /** Called after the matching PostgreSQL write has finished. */
  async publish(jobId: string, eventType: string): Promise<void> {
    if (!this.publisher) return;
    const notice: JobUpdateNotice = {
      jobId,
      eventType,
      occurredAt: new Date().toISOString(),
    };
    await this.publisher.publish(JOB_UPDATES_CHANNEL, JSON.stringify(notice));
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit();
    await this.publisher?.quit();
  }
}
