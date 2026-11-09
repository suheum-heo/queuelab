import { Module } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, StorageService],
  exports: [UploadsService, StorageService],
})
export class UploadsModule {}
