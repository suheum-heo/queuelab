import { Injectable } from '@nestjs/common';
import type { JobStatus, MetricsOverview } from '@queuelab/shared-types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(userId: string): Promise<MetricsOverview> {
    const groups = await this.prisma.job.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    });
    const count = (status: JobStatus) =>
      groups.find((group) => group.status === status)?._count._all ?? 0;

    const pendingEnqueue = count('PENDING_ENQUEUE');
    const queued = count('QUEUED');
    const processing = count('PROCESSING');
    const retrying = count('RETRYING');
    const completed = count('COMPLETED');
    const failed = count('FAILED');

    return {
      total: pendingEnqueue + queued + processing + retrying + completed + failed,
      pendingEnqueue,
      queued,
      processing,
      retrying,
      completed,
      failed,
    };
  }
}
