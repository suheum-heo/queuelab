import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [UploadsModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
