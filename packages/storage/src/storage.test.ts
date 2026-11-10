import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assertProductionObjectStorage, createObjectStore, isMissingObject, LocalObjectStore } from './index';
import { safeObjectKey } from './keys';

describe('object keys', () => {
  it('keeps a relative upload or report key', () => {
    assert.equal(safeObjectKey('uploads/10000000-0000-4000-8000-000000000001.csv'), 'uploads/10000000-0000-4000-8000-000000000001.csv');
    assert.equal(
      safeObjectKey('results/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002.json'),
      'results/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002.json',
    );
  });

  it('rejects a key that leaves the store', () => {
    assert.throws(() => safeObjectKey('../.env'));
    assert.throws(() => safeObjectKey('/etc/passwd'));
    assert.throws(() => safeObjectKey('uploads/../secret'));
  });
});

describe('production object storage', () => {
  it('requires a bucket and credentials when NODE_ENV is production', () => {
    assert.throws(() => assertProductionObjectStorage({ NODE_ENV: 'production' }));
    assert.doesNotThrow(() =>
      assertProductionObjectStorage({
        NODE_ENV: 'production',
        S3_BUCKET: 'queuelab',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    );
    assert.doesNotThrow(() => assertProductionObjectStorage({ NODE_ENV: 'development' }));
  });

  it('uses the local directory until a bucket is configured', () => {
    const store = createObjectStore('/tmp/queuelab-storage', {});
    assert.ok(store instanceof LocalObjectStore);
  });
});

describe('local object store', () => {
  it('publishes a whole object and streams it back with its size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'queuelab-storage-'));
    try {
      const store = new LocalObjectStore(root);
      await store.write('uploads/file.csv', 'order_id,sku\n1,a\n');
      assert.equal(await store.exists('uploads/file.csv'), true);
      const opened = await store.open('uploads/file.csv');
      assert.equal(opened.size, Buffer.byteLength('order_id,sku\n1,a\n'));
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'order_id,sku\n1,a\n');
      assert.equal(await readFile(join(root, 'uploads/file.csv'), 'utf8'), 'order_id,sku\n1,a\n');
      await store.remove('uploads/file.csv');
      assert.equal(await store.exists('uploads/file.csv'), false);
      await assert.rejects(store.open('uploads/missing.csv'), (error: unknown) => isMissingObject(error));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
