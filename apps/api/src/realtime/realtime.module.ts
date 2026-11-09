import { Module } from '@nestjs/common';
import { JobUpdatesService } from './job-updates.service';
import { JobsGateway } from './jobs.gateway';

@Module({
  providers: [JobsGateway, JobUpdatesService],
  exports: [JobUpdatesService],
})
export class RealtimeModule {}
