import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parse, type Options as ParseOptions } from 'csv-parse';
import {
  CSV_REQUIRED_COLUMNS,
  CsvAggregator,
  PermanentCsvError,
  assertRequiredColumns,
  normalizeHeader,
  type AnalysisReport,
} from '@queuelab/shared-types';

export interface CsvProgress {
  processedRows: number;
  progress: number;
}

/**
 * Reads the CSV as a stream. Rows are folded into totals and discarded.
 * Progress uses file size, which stays correct when a quoted field contains a newline.
 */
export async function analyzeCsvFile(
  filePath: string,
  options: { delimiter: string; hasHeader: boolean },
  onProgress?: (progress: CsvProgress) => Promise<void>,
): Promise<AnalysisReport> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') {
      throw new PermanentCsvError('Uploaded CSV is missing from storage');
    }
    throw error;
  }
  if (size === 0) {
    throw new PermanentCsvError('CSV file is empty');
  }

  const aggregator = new CsvAggregator();
  let bytesRead = 0;
  let lastEmit = Date.now();
  const source = createReadStream(filePath);
  source.on('data', (chunk: Buffer | string) => {
    bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });

  const parser = source.pipe(
    parse({
      bom: true,
      delimiter: options.delimiter,
      columns: headerColumns(options.hasHeader, aggregator),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    } satisfies ParseOptions),
  );

  let rows = 0;
  try {
    for await (const record of parser) {
      rows += 1;
      aggregator.add(record as Record<string, string | undefined>, rows);
      if (!onProgress) continue;
      const progress = Math.min(99, Math.round((bytesRead / size) * 100));
      const now = Date.now();
      if (rows % 500 === 0 || now - lastEmit >= 500) {
        lastEmit = now;
        await onProgress({ processedRows: rows, progress });
      }
    }
  } catch (error) {
    const permanent = permanentCsvError(error);
    if (permanent) throw permanent;
    throw error;
  }

  if (rows === 0) {
    throw new PermanentCsvError(
      options.hasHeader ? 'CSV has a header but no data rows' : 'CSV has no data rows',
    );
  }
  if (aggregator.validRows === 0) {
    const sample = aggregator.invalidSamples[0];
    throw new PermanentCsvError(
      sample
        ? `Every row failed validation. Row ${sample.rowNumber}: ${sample.reason}`
        : 'Every row failed validation',
    );
  }

  if (onProgress) {
    await onProgress({ processedRows: rows, progress: 100 });
  }
  return aggregator.finish();
}

function headerColumns(hasHeader: boolean, aggregator: CsvAggregator): ParseOptions['columns'] {
  if (!hasHeader) {
    aggregator.columns = [...CSV_REQUIRED_COLUMNS];
    return [...CSV_REQUIRED_COLUMNS];
  }

  return (headers: string[]) => {
    const normalized = headers.map((header) => normalizeHeader(header));
    assertRequiredColumns(normalized);
    aggregator.columns = normalized;
    return normalized;
  };
}

export function permanentCsvError(error: unknown): PermanentCsvError | null {
  if (error instanceof PermanentCsvError) return error;
  if (error instanceof Error && error.name === 'PermanentCsvError') {
    return new PermanentCsvError(error.message);
  }
  if (error instanceof Error && 'code' in error && String(error.code).startsWith('CSV_')) {
    return new PermanentCsvError(error.message);
  }
  return null;
}

function nodeCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
