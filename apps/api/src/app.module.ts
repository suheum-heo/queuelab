import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [PrismaModule, QueueModule, UploadsModule, HealthModule, JobsModule, MetricsModule],
})
export class AppModule {}
