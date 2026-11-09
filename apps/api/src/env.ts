import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Repository root not found from ${start}`);
}

export function storagePath(repoRoot: string): string {
  const configured = process.env.STORAGE_PATH ?? 'storage';
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
}
