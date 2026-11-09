import {
  Controller,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES } from '@queuelab/shared-types';
import { UploadExceptionFilter } from './upload-exception.filter';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@Controller('uploads')
@UseFilters(UploadExceptionFilter)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @ApiOperation({ summary: 'Store a CSV and return its file id' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  save(
    @UploadedFile()
    file: { originalname: string; size: number; buffer: Buffer } | undefined,
  ) {
    return this.uploads.save(file);
  }
}
