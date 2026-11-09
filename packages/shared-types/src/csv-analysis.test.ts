import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CsvAggregator,
  PermanentCsvError,
  assertRequiredColumns,
  normalizeHeader,
  parseAmountCents,
} from './csv-analysis';

describe('normalizeHeader', () => {
  it('matches the expected sales columns regardless of case and spacing', () => {
    assert.equal(normalizeHeader('Order ID'), 'order_id');
    assert.equal(normalizeHeader(' SKU '), 'sku');
    assert.equal(normalizeHeader('Quantity'), 'quantity');
    assert.equal(normalizeHeader('\uFEFFAmount'), 'amount');
  });
});

describe('assertRequiredColumns', () => {
  it('rejects a file that cannot produce quantity and amount', () => {
    assert.throws(
      () => assertRequiredColumns(['order_id', 'sku']),
      (error: unknown) => error instanceof PermanentCsvError && /quantity/.test(error.message),
    );
  });

  it('rejects duplicate headers', () => {
    assert.throws(() => assertRequiredColumns(['order_id', 'order_id', 'sku', 'quantity', 'amount']));
  });
});

describe('CsvAggregator', () => {
  it('sums only valid rows and keeps a short sample of the rest', () => {
    const aggregator = new CsvAggregator();
    aggregator.add({ order_id: '1', sku: 'A', quantity: '2', amount: '10.50' }, 1);
    aggregator.add({ order_id: '2', sku: 'B', quantity: '1', amount: '2.25' }, 2);
    aggregator.add({ order_id: '', sku: 'C', quantity: '4', amount: '9.00' }, 3);
    aggregator.add({ order_id: '4', sku: 'D', quantity: '-1', amount: '3' }, 4);
    aggregator.add({ order_id: '5', sku: 'E', quantity: '1', amount: '$8' }, 5);

    const report = aggregator.finish();
    assert.equal(report.mode, 'csv');
    assert.equal(report.totalRows, 5);
    assert.equal(report.validRows, 2);
    assert.equal(report.invalidRows, 3);
    assert.equal(report.totals.quantity, 3);
    assert.equal(report.totals.amount, 12.75);
    assert.equal(report.invalidSamples?.length, 3);
    assert.equal(report.invalidSamples?.[0]?.rowNumber, 3);
  });

  it('caps stored invalid samples so the report does not grow with the file', () => {
    const aggregator = new CsvAggregator();
    for (let row = 1; row <= 30; row += 1) {
      aggregator.add({ order_id: '', sku: 'A', quantity: '1', amount: '1' }, row);
    }
    const report = aggregator.finish();
    assert.equal(report.invalidRows, 30);
    assert.equal(report.invalidSamples?.length, 20);
    assert.equal(report.validRows, 0);
  });

  it('returns the same totals when the same rows are folded twice', () => {
    const rows = [
      { order_id: '1', sku: 'A', quantity: '2', amount: '10.555' },
      { order_id: '2', sku: 'B', quantity: '1.5', amount: '-2.00' },
    ];
    const first = new CsvAggregator();
    const second = new CsvAggregator();
    for (const [index, row] of rows.entries()) {
      first.add(row, index + 1);
      second.add(row, index + 1);
    }
    assert.deepEqual(first.finish(), second.finish());
    assert.equal(parseAmountCents('10.555'), 1056);
    assert.equal(first.finish().totals.amount, 8.56);
  });
});
