import { PrismaClient } from '@prisma/client';

export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async acquireLock(lockKey: string): Promise<boolean> {
    try {
      await this.prisma.idempotency.create({
        data: {
          idempotency_key: lockKey,
          status: 'LOCKED',
        },
      });
      return true;
    } catch (error: any) {
      // P2002 indica duplicado de Primary Key en Prisma (ya está procesado o en progreso)
      if (error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  async markAsProcessed(lockKey: string): Promise<void> {
    await this.prisma.idempotency.update({
      where: { idempotency_key: lockKey },
      data: {
        status: 'PROCESSED',
        processed_at: new Date(),
      },
    });
  }

  async releaseLock(lockKey: string): Promise<void> {
    try {
      await this.prisma.idempotency.delete({
        where: { idempotency_key: lockKey },
      });
    } catch (error) {
      // Ignorar si el registro ya no existía
    }
  }
}