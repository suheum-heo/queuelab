import { LocalObjectStore } from './local';
import { S3ObjectStore } from './s3';
import type { ObjectStore, StorageEnv } from './types';

export type { ObjectStore, StorageEnv, StoredObject } from './types';
export { MissingObjectError, isMissingObject } from './types';

/**
 * Production refuses a private disk. Two containers cannot share `STORAGE_PATH`,
 * so uploads and reports live in an S3-compatible bucket.
 */
export function assertProductionObjectStorage(env: StorageEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter(
    (name) => !(env[name as keyof StorageEnv]?.trim()),
  );
  if (missing.length > 0) {
    throw new Error(`Production requires object storage. Set ${missing.join(', ')}.`);
  }
}

export function createObjectStore(localRoot: string, env: StorageEnv = process.env): ObjectStore {
  assertProductionObjectStorage(env);
  const bucket = env.S3_BUCKET?.trim();
  if (bucket) return new S3ObjectStore(bucket, env);
  return new LocalObjectStore(localRoot);
}

export { LocalObjectStore } from './local';

export function localObjectStore(root: string): LocalObjectStore {
  return new LocalObjectStore(root);
}
export { safeObjectKey } from './keys';
