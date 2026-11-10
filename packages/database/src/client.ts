import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from './generated/prisma/client';

export function createPrismaClient(connectionString: string): PrismaClient {
  const parsed = Number(process.env.DATABASE_POOL_MAX);
  const adapter =
    Number.isFinite(parsed) && parsed > 0
      ? new PrismaPg(new Pool({ connectionString, max: parsed }))
      : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export { PrismaClient };
export type { Prisma } from './generated/prisma/client';
