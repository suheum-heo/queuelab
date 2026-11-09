import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PermanentCsvError } from '@queuelab/shared-types';
import { analyzeCsvFile } from './analyze-file';

const HEADER = 'order_id,sku,quantity,amount';

describe('analyzeCsvFile', () => {
  it('streams quoted fields and excludes invalid rows from the totals', async () => {
    const csv = [
      HEADER,
      '1001,"mug, blue",2,10.50',
      '1002,pen,1,2.25',
      ',sticker,4,1.00',
      '1004,notebook,x,8.00',
    ].join('\n');

    const report = await withCsv(csv, (file) =>
      analyzeCsvFile(file, { delimiter: ',', hasHeader: true }),
    );

    assert.equal(report.mode, 'csv');
    assert.equal(report.totalRows, 4);
    assert.equal(report.validRows, 2);
    assert.equal(report.invalidRows, 2);
    assert.equal(report.totals.quantity, 3);
    assert.equal(report.totals.amount, 12.75);
    assert.deepEqual(
      report.invalidSamples?.map((sample) => sample.reason),
      ['order_id is empty', 'quantity must be a non-negative number'],
    );
  });

  it('reads the same file twice without changing the report', async () => {
    const csv = `${HEADER}\n1,a,2,4.00\n2,b,3,5.50\n`;
    await withCsv(csv, async (file) => {
      const first = await analyzeCsvFile(file, { delimiter: ',', hasHeader: true });
      const second = await analyzeCsvFile(file, { delimiter: ',', hasHeader: true });
      assert.deepEqual(first, second);
    });
  });

  it('treats a broken quote as a permanent file error', async () => {
    const csv = `${HEADER}\n"1,abc,2,3.00\n`;
    await assert.rejects(
      () => withCsv(csv, (file) => analyzeCsvFile(file, { delimiter: ',', hasHeader: true })),
      (error: unknown) => error instanceof PermanentCsvError,
    );
  });

  it('rejects a header that cannot support the summary', async () => {
    await assert.rejects(
      () =>
        withCsv('name,notes\nAda,hello\n', (file) =>
          analyzeCsvFile(file, { delimiter: ',', hasHeader: true }),
        ),
      /required columns/,
    );
  });

  it('reports completion once for a file that fits in a single read', async () => {
    const updates: number[] = [];
    await withCsv(`${HEADER}\n1,a,1,1.00\n2,b,1,1.00\n`, (file) =>
      analyzeCsvFile(file, { delimiter: ',', hasHeader: true }, async (progress) => {
        updates.push(progress.progress);
      }),
    );
    assert.deepEqual(updates, [100]);
  });

  it('does not report byte progress for every row', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 1200; i += 1) {
      lines.push(`${i},sku,1,1.00`);
    }
    const updates: number[] = [];
    await withCsv(lines.join('\n'), (file) =>
      analyzeCsvFile(file, { delimiter: ',', hasHeader: true }, async (progress) => {
        updates.push(progress.processedRows);
      }),
    );
    assert.ok(updates.length < 20);
    assert.equal(updates.at(-1), 1200);
  });
});

async function withCsv<T>(contents: string, run: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'queuelab-csv-'));
  const file = join(directory, 'input.csv');
  await writeFile(file, contents);
  try {
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
