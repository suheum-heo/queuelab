/** Redis pub/sub channel. The payload is a hint, not the job row. */
export const JOB_UPDATES_CHANNEL = 'queuelab:job-updates';

/** Socket.IO event. Clients refetch the REST resource after receiving it. */
export const JOB_UPDATE_EVENT = 'job.updated';

export const LEDGER_SUBSCRIBE = 'jobs.subscribe';
export const JOB_SUBSCRIBE = 'job.subscribe';
export const JOB_UNSUBSCRIBE = 'job.unsubscribe';

export interface JobUpdateNotice {
  jobId: string;
  eventType: string;
  occurredAt: string;
}

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accepts the Redis string or the object Socket.IO already decoded. */
export function readJobUpdateNotice(value: unknown): JobUpdateNotice | null {
  let record = value;
  if (typeof value === 'string') {
    try {
      record = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== 'object') return null;

  const notice = record as Partial<JobUpdateNotice>;
  if (typeof notice.jobId !== 'string' || !JOB_ID.test(notice.jobId)) return null;
  if (typeof notice.eventType !== 'string' || !/^[A-Z_]{1,40}$/.test(notice.eventType)) return null;
  if (typeof notice.occurredAt !== 'string' || Number.isNaN(Date.parse(notice.occurredAt))) return null;

  return {
    jobId: notice.jobId,
    eventType: notice.eventType,
    occurredAt: notice.occurredAt,
  };
}
