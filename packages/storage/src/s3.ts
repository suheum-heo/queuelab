import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MissingObjectError, type ObjectStore, type StorageEnv, type StoredObject } from './types';
import { safeObjectKey } from './keys';

/** Shared by the API and the worker. A put replaces the whole object. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    env: StorageEnv,
  ) {
    this.client = new S3Client({
      region: env.S3_REGION?.trim() || 'us-east-1',
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID?.trim() ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() ?? '',
      },
    });
  }

  async read(key: string): Promise<Buffer> {
    const { stream } = await this.open(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async write(key: string, body: Buffer | string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeObjectKey(key),
        Body: typeof body === 'string' ? Buffer.from(body) : body,
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: safeObjectKey(key),
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeObjectKey(key) }));
      return true;
    } catch (error) {
      if (isAbsent(error)) return false;
      throw error;
    }
  }

  async open(key: string): Promise<StoredObject> {
    const safe = safeObjectKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safe }));
      if (!response.Body || typeof response.ContentLength !== 'number') {
        throw new Error(`Object ${safe} did not include a body and size`);
      }
      return { stream: response.Body as Readable, size: response.ContentLength };
    } catch (error) {
      if (isAbsent(error)) throw new MissingObjectError(key);
      throw error;
    }
  }
}

function isAbsent(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound || error instanceof MissingObjectError) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}
