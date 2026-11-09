import { filenameFromJob, isSeededJob, type JobView } from '@queuelab/shared-types';

export interface JobRecord {
  id: string;
  type: JobView['type'];
  status: JobView['status'];
  progress: number;
  attempts: number;
  maxAttempts: number;
  inputKey: string | null;
  resultKey: string | null;
  errorMessage: string | null;
  options: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export function presentJob(job: JobRecord): JobView {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    attemptsMade: job.attempts,
    maxAttempts: job.maxAttempts,
    filename: filenameFromJob(job.inputKey, job.options),
    seeded: isSeededJob(job.options),
    inputKey: job.inputKey,
    resultKey: job.resultKey,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
