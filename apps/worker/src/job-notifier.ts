import { JOB_UPDATES_CHANNEL, type JobUpdateNotice } from '@queuelab/shared-types';
import { Redis } from 'ioredis';

export interface JobNotifier {
  publish(jobId: string, eventType: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Separate from the BullMQ connection. A missed publish does not fail the job:
 * the notice is not the ledger, and the client refetches after it reconnects.
 */
export function createJobNotifier(redisUrl: string): JobNotifier {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });

  return {
    async publish(jobId, eventType) {
      const notice: JobUpdateNotice = {
        jobId,
        eventType,
        occurredAt: new Date().toISOString(),
      };
      try {
        await redis.publish(JOB_UPDATES_CHANNEL, JSON.stringify(notice));
      } catch (error) {
        console.error('[worker] job notice was not published', error);
      }
    },
    async close() {
      await redis.quit();
    },
  };
}
