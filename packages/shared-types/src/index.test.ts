import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeCursor,
  encodeCursor,
  filenameFromJob,
  simulateAnalysis,
} from './index';

const JOB_ID = '8b72e2bf-43d1-4c73-9db2-a2c51743c190';

describe('cursor', () => {
  it('round-trips a timestamp and job id', () => {
    const createdAt = new Date('2026-11-09T18:00:00.000Z');
    const decoded = decodeCursor(encodeCursor(createdAt, JOB_ID));
    assert.equal(decoded.id, JOB_ID);
    assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  });

  it('rejects a cursor that is not a timestamp and uuid', () => {
    assert.throws(() => decodeCursor(Buffer.from('not-a-cursor', 'utf8').toString('base64url')));
  });
});

describe('filenameFromJob', () => {
  it('prefers the options filename', () => {
    assert.equal(
      filenameFromJob('incoming/other.csv', { filename: 'sales_2026.csv' }),
      'sales_2026.csv',
    );
  });

  it('falls back to the storage key basename', () => {
    assert.equal(filenameFromJob('demo/customers.csv', {}), 'customers.csv');
  });
});

describe('simulateAnalysis', () => {
  it('is deterministic and conserves row counts', () => {
    const first = simulateAnalysis(JOB_ID, 10_000);
    const second = simulateAnalysis(JOB_ID, 10_000);
    assert.deepEqual(first, second);
    assert.equal(first.totalRows, 10_000);
    assert.equal(first.validRows + first.invalidRows, 10_000);
    assert.equal(first.mode, 'simulated');
  });

  it('changes when the job id changes', () => {
    const left = simulateAnalysis(JOB_ID, 2000);
    const right = simulateAnalysis('11111111-1111-4111-8111-111111111111', 2000);
    assert.notEqual(left.totals.amount, right.totals.amount);
  });
});
