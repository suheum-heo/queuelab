import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readJobUpdateNotice } from './job-notice';

const NOTICE = {
  jobId: '8b72e2bf-43d1-4c73-9db2-a2c51743c190',
  eventType: 'PROGRESS',
  occurredAt: '2026-11-09T18:00:00.000Z',
};

describe('readJobUpdateNotice', () => {
  it('reads the Redis payload and the Socket.IO object', () => {
    assert.deepEqual(readJobUpdateNotice(JSON.stringify(NOTICE)), NOTICE);
    assert.deepEqual(readJobUpdateNotice(NOTICE), NOTICE);
  });

  it('drops a payload that cannot identify a job', () => {
    assert.equal(readJobUpdateNotice('not-json'), null);
    assert.equal(readJobUpdateNotice({ ...NOTICE, jobId: 'job-1' }), null);
    assert.equal(readJobUpdateNotice({ ...NOTICE, eventType: 'progress' }), null);
    assert.equal(readJobUpdateNotice({ ...NOTICE, occurredAt: 'yesterday' }), null);
  });
});
