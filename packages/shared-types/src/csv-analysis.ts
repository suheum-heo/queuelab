export const CSV_REQUIRED_COLUMNS = ['order_id', 'sku', 'quantity', 'amount'] as const;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const MAX_INVALID_SAMPLES = 20;

export class PermanentCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentCsvError';
  }
}

export interface InvalidSample {
  rowNumber: number;
  reason: string;
}

export interface AnalysisReport {
  mode: 'simulated' | 'csv';
  note: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  columns: string[];
  totals: { quantity: number; amount: number };
  averages: { quantity: number; amount: number };
  invalidSamples?: InvalidSample[];
}

export function normalizeHeader(name: string): string {
  return name
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function assertRequiredColumns(headers: readonly string[]): void {
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) {
      throw new PermanentCsvError(`Duplicate column "${header}"`);
    }
    seen.add(header);
  }

  const missing = CSV_REQUIRED_COLUMNS.filter((column) => !seen.has(column));
  if (missing.length > 0) {
    throw new PermanentCsvError(`CSV is missing required columns: ${missing.join(', ')}`);
  }
}

/**
 * Validates one record and folds it into running totals.
 * Invalid rows are counted and sampled. They are not retained, so a large
 * file does not accumulate an array of every source row.
 */
export class CsvAggregator {
  totalRows = 0;
  validRows = 0;
  invalidRows = 0;
  quantity = 0;
  private amountCents = 0;
  readonly invalidSamples: InvalidSample[] = [];
  columns: string[] = [...CSV_REQUIRED_COLUMNS];

  add(record: Record<string, string | undefined>, rowNumber: number): void {
    this.totalRows += 1;
    const parsed = parseRecord(record);
    if (!parsed.ok) {
      this.invalidRows += 1;
      if (this.invalidSamples.length < MAX_INVALID_SAMPLES) {
        this.invalidSamples.push({ rowNumber, reason: parsed.reason });
      }
      return;
    }

    this.validRows += 1;
    this.quantity += parsed.quantity;
    this.amountCents += parsed.amountCents;
  }

  finish(): AnalysisReport {
    const amount = this.amountCents / 100;
    return {
      mode: 'csv',
      note:
        this.invalidRows === 0
          ? 'Totals come from the uploaded CSV. Invalid rows are excluded from the sums.'
          : 'Totals come from the uploaded CSV. Invalid rows were counted and excluded from the sums.',
      totalRows: this.totalRows,
      validRows: this.validRows,
      invalidRows: this.invalidRows,
      columns: this.columns,
      totals: {
        quantity: roundQuantity(this.quantity),
        amount,
      },
      averages: {
        quantity: this.validRows === 0 ? 0 : roundQuantity(this.quantity / this.validRows),
        amount: this.validRows === 0 ? 0 : roundCents(this.amountCents / this.validRows) / 100,
      },
      invalidSamples: this.invalidSamples,
    };
  }
}

function parseRecord(
  record: Record<string, string | undefined>,
): { ok: true; quantity: number; amountCents: number } | { ok: false; reason: string } {
  const orderId = (record.order_id ?? '').trim();
  const sku = (record.sku ?? '').trim();
  if (!orderId) return { ok: false, reason: 'order_id is empty' };
  if (!sku) return { ok: false, reason: 'sku is empty' };

  const quantity = parseQuantity(record.quantity);
  if (quantity === null) return { ok: false, reason: 'quantity must be a non-negative number' };

  const amountCents = parseAmountCents(record.amount);
  if (amountCents === null) return { ok: false, reason: 'amount must be a decimal number' };

  return { ok: true, quantity, amountCents };
}

function parseQuantity(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Accepts an optional leading minus and at most a fractional part. Returns integer cents. */
export function parseAmountCents(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = `${fraction}000`;
  const cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  const rounded = padded[2] >= '5' ? cents + 1 : cents;
  if (!Number.isSafeInteger(rounded)) return null;
  return negative ? -rounded : rounded;
}

function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundCents(value: number): number {
  return Math.round(value);
}
