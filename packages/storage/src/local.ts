import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { MissingObjectError, type ObjectStore, type StoredObject } from './types';
import { safeObjectKey } from './keys';

/** The development store. Production uses the bucket instead of this directory. */
export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.fullPath(key));
  }

  async write(key: string, body: Buffer | string): Promise<void> {
    const full = this.fullPath(key);
    await mkdir(dirname(full), { recursive: true });
    const temporary = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, full);
  }

  async remove(key: string): Promise<void> {
    await rm(this.fullPath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.fullPath(key));
      return true;
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async open(key: string): Promise<StoredObject> {
    const full = this.fullPath(key);
    try {
      const info = await stat(full);
      return { stream: createReadStream(full), size: info.size };
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') throw new MissingObjectError(key);
      throw error;
    }
  }

  private fullPath(key: string): string {
    const full = resolve(this.root, safeObjectKey(key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return full;
  }
}

function nodeCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
