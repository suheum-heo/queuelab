import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobUpdatesService } from './job-updates.service';
import { JobsGateway } from './jobs.gateway';

@Module({
  imports: [AuthModule],
  providers: [JobsGateway, JobUpdatesService],
  exports: [JobUpdatesService],
})
export class RealtimeModule {}
