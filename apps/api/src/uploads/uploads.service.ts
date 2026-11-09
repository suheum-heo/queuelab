import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { MAX_UPLOAD_BYTES } from '@queuelab/shared-types';
import { StorageService } from '../storage/storage.service';

const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredUpload {
  id: string;
  filename: string;
  sizeBytes: number;
  key: string;
}

interface UploadBody {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class UploadsService {
  constructor(private readonly storage: StorageService) {}

  async save(file: UploadBody | undefined): Promise<StoredUpload> {
    if (!file?.buffer) {
      throw new BadRequestException('Choose a CSV file to upload');
    }
    if (file.size === 0 || file.buffer.length === 0) {
      throw new BadRequestException('CSV file is empty');
    }
    if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('CSV files must be 10 MB or smaller');
    }

    const filename = displayName(file.originalname);
    if (!filename) {
      throw new BadRequestException('Only .csv files are accepted');
    }
    if (file.buffer.subarray(0, 8192).includes(0)) {
      throw new BadRequestException('File does not look like a text CSV');
    }

    const id = randomUUID();
    const key = `uploads/${id}.csv`;
    await this.storage.write(key, file.buffer);
    try {
      await this.storage.write(
        `uploads/${id}.json`,
        JSON.stringify({
          id,
          filename,
          sizeBytes: file.buffer.length,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      await this.storage.remove(key);
      throw error;
    }

    return { id, filename, sizeBytes: file.buffer.length, key };
  }

  async require(id: string): Promise<StoredUpload> {
    if (!FILE_ID.test(id)) {
      throw new BadRequestException('Invalid file id');
    }

    const key = `uploads/${id}.csv`;
    let meta: { filename?: unknown; sizeBytes?: unknown };
    try {
      meta = JSON.parse((await this.storage.read(`uploads/${id}.json`)).toString('utf8')) as {
        filename?: unknown;
        sizeBytes?: unknown;
      };
    } catch {
      throw new BadRequestException('Upload not found. Send the CSV again.');
    }
    if (!(await this.storage.exists(key))) {
      throw new BadRequestException('Upload not found. Send the CSV again.');
    }

    return {
      id,
      filename: typeof meta.filename === 'string' && meta.filename.trim() ? meta.filename : 'upload.csv',
      sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0,
      key,
    };
  }
}

function displayName(original: string): string {
  const base = basename(original).replace(/[/\\]/g, '').trim();
  if (!base.toLowerCase().endsWith('.csv')) return '';
  return base.slice(0, 120);
}
