import { config } from 'dotenv';
import { isAbsolute, resolve } from 'node:path';
import { createObjectStore } from '@queuelab/storage';
import { simulateAnalysis, type CsvAnalysisOptions } from '@queuelab/shared-types';
import { createPrismaClient } from '../src/client';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });

const DEMO_EMAIL = process.env.DEMO_USER_EMAIL ?? 'demo@queuelab.dev';
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

const IDS = {
  sales: '10000000-0000-4000-8000-000000000001',
  customers: '10000000-0000-4000-8000-000000000002',
  inventory: '10000000-0000-4000-8000-000000000003',
  orders: '10000000-0000-4000-8000-000000000004',
  refunds: '10000000-0000-4000-8000-000000000005',
  shipments: '10000000-0000-4000-8000-000000000006',
} as const;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function storageRoot(): string {
  const configured = process.env.STORAGE_PATH ?? 'storage';
  if (isAbsolute(configured)) return configured;
  return resolve(process.cwd(), '../..', configured);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const prisma = createPrismaClient(databaseUrl);
  const reports = createObjectStore(storageRoot());

  try {
    await prisma.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: { id: DEMO_USER_ID, email: DEMO_EMAIL },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } });
    const ids = Object.values(IDS);

    await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.jobResult.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });

    const customersReport = simulateAnalysis(IDS.customers, 8420);
    const refundsReport = simulateAnalysis(IDS.refunds, 1260);

    await writeReport(reports, IDS.customers, customersReport);
    await writeReport(reports, IDS.refunds, refundsReport);

    await prisma.job.create({
      data: {
        id: IDS.sales,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'PROCESSING',
        progress: 68,
        attempts: 1,
        maxAttempts: 3,
        inputKey: 'demo/sales_2026.csv',
        options: options('sales_2026.csv'),
        createdAt: minutesAgo(6),
        startedAt: minutesAgo(4),
        events: {
          create: [
            event('CREATED', 'Sample job inserted by the seed', minutesAgo(6)),
            event('QUEUED', 'Sample record only — not present in Redis', minutesAgo(6)),
            event('PROCESSING', 'Snapshot of a job at 68% for the dashboard', minutesAgo(4), {
              progress: 68,
            }),
          ],
        },
      },
    });

    await prisma.job.create({
      data: {
        id: IDS.customers,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'COMPLETED',
        progress: 100,
        attempts: 1,
        maxAttempts: 3,
        inputKey: 'demo/customers.csv',
        resultKey: `results/${IDS.customers}.json`,
        options: options('customers.csv'),
        createdAt: hoursAgo(5),
        startedAt: hoursAgo(5),
        finishedAt: hoursAgo(4.8),
        events: {
          create: [
            event('CREATED', 'Sample job inserted by the seed', hoursAgo(5)),
            event('COMPLETED', 'Sample report stored', hoursAgo(4.8)),
          ],
        },
        result: {
          create: {
            totalRows: customersReport.totalRows,
            validRows: customersReport.validRows,
            invalidRows: customersReport.invalidRows,
            summary: customersReport,
          },
        },
      },
    });

    await prisma.job.create({
      data: {
        id: IDS.inventory,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'FAILED',
        progress: 34,
        attempts: 3,
        maxAttempts: 3,
        inputKey: 'demo/inventory.csv',
        errorMessage: 'Simulated transient failure while aggregating rows',
        options: options('inventory.csv'),
        createdAt: hoursAgo(2),
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(1.7),
        events: {
          create: [
            event('CREATED', 'Sample job inserted by the seed', hoursAgo(2)),
            event('FAILED', 'Sample failure. This row is not a live execution and cannot be retried.', hoursAgo(1.7)),
          ],
        },
      },
    });

    await prisma.job.create({
      data: {
        id: IDS.orders,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'QUEUED',
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        inputKey: 'demo/orders_q1.csv',
        options: options('orders_q1.csv'),
        createdAt: minutesAgo(20),
        events: {
          create: [event('CREATED', 'Sample job waiting in the ledger, not in Redis', minutesAgo(20))],
        },
      },
    });

    await prisma.job.create({
      data: {
        id: IDS.refunds,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'COMPLETED',
        progress: 100,
        attempts: 1,
        maxAttempts: 3,
        inputKey: 'demo/refunds.csv',
        resultKey: `results/${IDS.refunds}.json`,
        options: options('refunds.csv'),
        createdAt: hoursAgo(26),
        startedAt: hoursAgo(26),
        finishedAt: hoursAgo(25.9),
        events: {
          create: [event('COMPLETED', 'Sample report stored', hoursAgo(25.9))],
        },
        result: {
          create: {
            totalRows: refundsReport.totalRows,
            validRows: refundsReport.validRows,
            invalidRows: refundsReport.invalidRows,
            summary: refundsReport,
          },
        },
      },
    });

    await prisma.job.create({
      data: {
        id: IDS.shipments,
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'RETRYING',
        progress: 12,
        attempts: 1,
        maxAttempts: 3,
        inputKey: 'demo/shipments.csv',
        errorMessage: 'Simulated lock timeout',
        options: options('shipments.csv'),
        createdAt: minutesAgo(12),
        startedAt: minutesAgo(11),
        events: {
          create: [
            event('PROCESSING', 'Sample attempt 1', minutesAgo(11)),
            event('RETRYING', 'Sample retry scheduled. This row is not a live BullMQ job.', minutesAgo(10)),
          ],
        },
      },
    });

    console.log(`Seeded demo user ${user.email} and ${ids.length} jobs`);
  } finally {
    await prisma.$disconnect();
  }
}

function options(filename: string): CsvAnalysisOptions {
  return {
    delimiter: ',',
    hasHeader: true,
    filename,
    seeded: true,
  };
}

function event(
  eventType: string,
  message: string,
  createdAt: Date,
  metadata?: Record<string, unknown>,
) {
  return {
    eventType,
    message,
    createdAt,
    ...(metadata ? { metadata } : {}),
  };
}

async function writeReport(
  reports: ReturnType<typeof createObjectStore>,
  jobId: string,
  report: unknown,
): Promise<void> {
  await reports.write(`results/${jobId}.json`, JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
