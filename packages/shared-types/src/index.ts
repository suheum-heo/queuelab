import type { AnalysisReport } from './csv-analysis';

export const JOB_STATUSES = [
  'PENDING_ENQUEUE',
  'QUEUED',
  'PROCESSING',
  'RETRYING',
  'COMPLETED',
  'FAILED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = ['CSV_ANALYSIS'] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const ACTIVE_STATUSES: readonly JobStatus[] = [
  'PENDING_ENQUEUE',
  'QUEUED',
  'PROCESSING',
  'RETRYING',
];

export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

export interface CsvAnalysisOptions {
  delimiter: string;
  hasHeader: boolean;
  filename: string;
  /** True for rows inserted by the demo seed, which are not attached to BullMQ. */
  seeded?: boolean;
}

export interface CsvAnalysisPayload {
  jobId: string;
  fileKey: string | null;
  options: CsvAnalysisOptions;
}

export const CSV_ANALYSIS_QUEUE = 'csv-analysis';
export const DEFAULT_MAX_ATTEMPTS = 3;

export type { AnalysisReport, InvalidSample } from './csv-analysis';
export {
  CSV_REQUIRED_COLUMNS,
  CsvAggregator,
  MAX_INVALID_SAMPLES,
  MAX_UPLOAD_BYTES,
  PermanentCsvError,
  assertRequiredColumns,
  normalizeHeader,
  parseAmountCents,
} from './csv-analysis';

/**
 * Deterministic stand-in used only by the database seed.
 * Live jobs stream the uploaded CSV. Seed rows are not in BullMQ.
 */
export function simulateAnalysis(jobId: string, totalRows: number): AnalysisReport {
  const rows = Math.max(0, Math.floor(totalRows));
  const seed = hashString(jobId);
  const invalidCap = Math.min(25, Math.floor(rows / 20));
  const invalidRows = rows === 0 || invalidCap === 0 ? 0 : seed % (invalidCap + 1);
  const validRows = rows - invalidRows;
  const quantity = validRows * (1 + (seed % 5));
  const amount = Math.round(validRows * (12.5 + (seed % 40)) * 100) / 100;

  return {
    mode: 'simulated',
    note: 'Generated for a seeded sample job. Live jobs stream an uploaded CSV instead of using these totals.',
    totalRows: rows,
    validRows,
    invalidRows,
    columns: ['order_id', 'sku', 'quantity', 'amount'],
    totals: { quantity, amount },
    averages: {
      quantity: validRows === 0 ? 0 : Math.round((quantity / validRows) * 100) / 100,
      amount: validRows === 0 ? 0 : Math.round((amount / validRows) * 100) / 100,
    },
  };
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function filenameFromJob(inputKey: string | null | undefined, options: unknown): string {
  if (options && typeof options === 'object' && 'filename' in options) {
    const filename = (options as { filename?: unknown }).filename;
    if (typeof filename === 'string' && filename.trim()) {
      return filename.trim();
    }
  }

  if (inputKey) {
    const base = inputKey.split('/').filter(Boolean).pop();
    if (base) return base;
  }

  return 'untitled.csv';
}

export function isSeededJob(options: unknown): boolean {
  return Boolean(
    options &&
      typeof options === 'object' &&
      'seeded' in options &&
      (options as { seeded?: unknown }).seeded === true,
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  if (separator <= 0) {
    throw new Error('Invalid cursor');
  }

  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new Error('Invalid cursor');
  }

  return { createdAt, id };
}

export interface JobView {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  filename: string;
  seeded: boolean;
  inputKey: string | null;
  resultKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobPage {
  items: JobView[];
  nextCursor: string | null;
}

export interface MetricsOverview {
  total: number;
  pendingEnqueue: number;
  queued: number;
  processing: number;
  retrying: number;
  completed: number;
  failed: number;
}

export interface JobEventView {
  id: string;
  jobId: string;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: string;
}

export interface JobEventPage {
  items: JobEventView[];
  nextCursor: string | null;
}

export interface JobResultView {
  id: string;
  jobId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  summary: unknown;
  createdAt: string;
}
