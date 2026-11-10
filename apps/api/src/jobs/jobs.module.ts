import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { UploadsModule } from '../uploads/uploads.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ReconcileService } from './reconcile.service';

@Module({
  imports: [UploadsModule, RealtimeModule],
  controllers: [JobsController],
  providers: [JobsService, ReconcileService],
})
export class JobsModule {}
