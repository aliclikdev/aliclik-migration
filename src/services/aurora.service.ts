import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

export function getAuroraDb(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env.AURORA_DATABASE_URL || process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('AURORA_DATABASE_URL environment variable is not defined.');
    }

    prisma = new PrismaClient({
      datasources: {
        db: {
          url: connectionString,
        },
      },
    });
  }

  return prisma;
}