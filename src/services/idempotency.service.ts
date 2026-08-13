import { getAuroraDb } from './aurora.service';

// Tiempo máximo esperado para que una migración termine. Si un lock lleva
// más de esto en estado LOCKED, se asume que el proceso que lo tomó murió
// (timeout de Lambda, OOM, etc.) sin llegar al catch que libera el lock, y
// se permite reintentar en vez de bloquear el evento para siempre.
const STALE_LOCK_MINUTES = 15;

/**
 * Adquiere un lock idempotente en Aurora.
 * @returns true si se adquirió (primera vez o recuperación de lock huérfano),
 *          false si ya existe un lock vigente o el evento ya fue procesado.
 */
export async function acquireSqsMigrationLock(eventId: string): Promise<boolean> {
  const db = getAuroraDb();
  const lockKey = `sqs_migration:${eventId}`;

  try {
    await db.idempotency.create({
      data: {
        key: lockKey,
        status: 'LOCKED',
      },
    });
    return true;
  } catch (error: any) {
    // P2002 es el código de Prisma para "Unique constraint violation"
    if (error?.code !== 'P2002') {
      throw error;
    }

    const existing = await db.idempotency.findUnique({ where: { key: lockKey } });

    // Carrera improbable: otro proceso borró el registro justo ahora.
    if (!existing) {
      return false;
    }

    // Ya fue procesado (con éxito o falla) previamente: es un duplicado real.
    if (existing.status !== 'LOCKED') {
      return false;
    }

    const ageMs = Date.now() - existing.processedAt.getTime();
    const isStale = ageMs > STALE_LOCK_MINUTES * 60 * 1000;

    if (!isStale) {
      // Lock vigente y reciente: otra ejecución lo está procesando ahora mismo.
      return false;
    }

    // Lock huérfano: lo retomamos de forma optimista, condicionando el UPDATE
    // al processedAt que leímos, para evitar que dos ejecuciones concurrentes
    // "rescaten" el mismo lock huérfano al mismo tiempo.
    const result = await db.idempotency.updateMany({
      where: {
        key: lockKey,
        status: 'LOCKED',
        processedAt: existing.processedAt,
      },
      data: {
        status: 'LOCKED',
        processedAt: new Date(),
      },
    });

    return result.count > 0;
  }
}

/**
 * Libera el lock y marca el estado final.
 */
export async function releaseSqsMigrationLock(
  eventId: string,
  status: 'PROCESSED' | 'FAILED' = 'PROCESSED'
): Promise<void> {
  const db = getAuroraDb();
  const lockKey = `sqs_migration:${eventId}`;

  await db.idempotency.update({
    where: { key: lockKey },
    data: {
      status,
      processedAt: new Date(),
    },
  });
}