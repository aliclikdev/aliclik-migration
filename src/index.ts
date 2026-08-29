import { SQSEvent, SQSHandler } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import { SqsMigrationUseCase } from './use-cases/sqs-migration.use-case';
import { IdempotencyService } from './services/idempotency.service';
import { SqsReplyService } from './services/sqs-reply.service';
import { UserMigrationMessage } from './types/sqs-migration.types';
import { logger } from './utils/logger';

const prisma = new PrismaClient();
const idempotencyService = new IdempotencyService();
const sqsReplyService = new SqsReplyService();
const migrationUseCase = new SqsMigrationUseCase(prisma, idempotencyService);

export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const payload: UserMigrationMessage = JSON.parse(record.body);

      // 1. Ejecutar el Use Case
      const result = await migrationUseCase.execute(payload);

      // 2. Determinar la URL de la cola de respuesta
      const replyQueueUrl = payload.replyToQueueUrl || process.env.RESPONSE_QUEUE_URL;

      // 3. Si es evento GET_USER y tenemos resultado y cola, enviamos la respuesta a NestJS
      if (payload.eventType === ('GET_USER' as any) && result && replyQueueUrl) {
        await sqsReplyService.sendReply(replyQueueUrl, payload.eventId, result);
      }
    } catch (error) {
      logger.error(`[HANDLER] Error procesando registro SQS ${record.messageId}:`, error);
      throw error;
    }
  }
};