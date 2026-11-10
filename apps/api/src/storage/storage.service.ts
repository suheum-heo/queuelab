import { Injectable } from '@nestjs/common';
import { createObjectStore, type ObjectStore } from '@queuelab/storage';
import { findRepoRoot, storagePath } from '../env';

@Injectable()
export class StorageService implements ObjectStore {
  private readonly store = createObjectStore(storagePath(findRepoRoot(__dirname)));

  read(key: string): Promise<Buffer> {
    return this.store.read(key);
  }

  write(key: string, body: Buffer | string): Promise<void> {
    return this.store.write(key, body);
  }

  exists(key: string): Promise<boolean> {
    return this.store.exists(key);
  }

  remove(key: string): Promise<void> {
    return this.store.remove(key);
  }

  open(key: string) {
    return this.store.open(key);
  }
}
