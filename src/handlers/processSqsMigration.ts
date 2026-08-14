import { SQSHandler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import { SqsMigrationUseCase } from '../use-cases/sqs-migration.use-case';
import { IdempotencyService } from '../services/idempotency.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const idempotencyService = new IdempotencyService(prisma);
const migrationUseCase = new SqsMigrationUseCase(prisma, idempotencyService);

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);

    // Asignamos el messageId de SQS a eventId si no viene dentro del body
    payload.eventId = `${payload.eventId}-${randomUUID()}` || record.messageId;

    await migrationUseCase.execute(payload);
  }
};