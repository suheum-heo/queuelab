import type { Readable } from 'node:stream';

export interface StoredObject {
  stream: Readable;
  size: number;
}

/** One object key is one CSV or one report. The API and the worker share this store. */
export interface ObjectStore {
  read(key: string): Promise<Buffer>;
  write(key: string, body: Buffer | string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  open(key: string): Promise<StoredObject>;
}

export class MissingObjectError extends Error {
  readonly code = 'ENOENT';

  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'MissingObjectError';
  }
}

export function isMissingObject(error: unknown): boolean {
  return error instanceof MissingObjectError || (error instanceof Error && error.name === 'MissingObjectError');
}

export interface StorageEnv {
  NODE_ENV?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
}
