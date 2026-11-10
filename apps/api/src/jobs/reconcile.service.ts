import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { JobUpdatesService } from '../realtime/job-updates.service';
import {
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_PENDING_MIN_AGE_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_STUCK_AFTER_MS,
  reconcileJobs,
} from './reconcile';

@Injectable()
export class ReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly updates: JobUpdatesService,
  ) {}

  onModuleInit(): void {
    if (process.env.RECONCILE_ENABLED === 'false') return;
    const interval = numberFromEnv('RECONCILE_INTERVAL_MS', DEFAULT_RECONCILE_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await reconcileJobs(
        this.prisma,
        this.queue.executionQueue(),
        (jobId, eventType) => this.updates.publish(jobId, eventType),
        {
          minPendingAgeMs: numberFromEnv('PENDING_ENQUEUE_MIN_AGE_MS', DEFAULT_PENDING_MIN_AGE_MS),
          stuckAfterMs: numberFromEnv('STUCK_JOB_AFTER_MS', DEFAULT_STUCK_AFTER_MS),
          claimLeaseMs: numberFromEnv('RECONCILE_CLAIM_LEASE_MS', DEFAULT_CLAIM_LEASE_MS),
        },
      );
      const acted =
        summary.pendingRecovered +
        summary.queueRestored +
        summary.failuresSynced +
        summary.completionsRepaired +
        summary.stuck;
      if (acted > 0) {
        this.logger.log(
          `Reconciled pending ${summary.pendingRecovered}, restored ${summary.queueRestored}, failed ${summary.failuresSynced}, completed ${summary.completionsRepaired}, stuck ${summary.stuck}`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Reconciler failed: ${reason}`);
    } finally {
      this.running = false;
    }
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
