import { Injectable } from '@nestjs/common';
import { findRepoRoot, storagePath } from '../env';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

@Injectable()
export class StorageService {
  readonly root = storagePath(findRepoRoot(__dirname));

  resolveKey(key: string): string {
    const root = resolve(this.root);
    const full = resolve(root, key);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }

  async write(key: string, body: Buffer | string): Promise<void> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }
}
