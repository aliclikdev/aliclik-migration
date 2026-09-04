// src/handlers/processImageMigration.ts

import { SQSHandler, SQSBatchResponse } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { ImageOptimizationUseCase } from "../use-cases/image-optimization.use-case";
import { IdempotencyService } from "../services/idempotency.service";
import { SqsReplyService } from "../services/sqs-reply.service";
import { ImageOptimizationMessage } from "../types/image-optimization.types";
import { logger } from "../utils/logger";

const prisma = new PrismaClient();
const idempotencyService = new IdempotencyService(prisma); // 👈 Si tu constructor no pide prisma, quítalo
const replyService = new SqsReplyService();
const useCase = new ImageOptimizationUseCase();

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    const { messageId, body } = record;
    let message: ImageOptimizationMessage;

    try {
      message = JSON.parse(body);
    } catch (e) {
      logger.error(
        `[IMAGE_MIGRATION] Payload inválido messageId=${messageId}: ${(e as Error).message}`,
      );
      continue; // Mensaje corrupto → DLQ
    }

    const eventId = message.eventId;
    let lockAcquired = false;

    try {
      // 1. Idempotencia con lock (patrón real del proyecto)
      lockAcquired = await idempotencyService.acquireLock(eventId);
      if (!lockAcquired) {
        logger.warn(
          `[IMAGE_MIGRATION] Evento omitido por idempotencia: ${eventId}`,
        );
        continue;
      }

      // 2. Ejecutar optimización
      const result = await useCase.execute(message);

      if (result.success) {
        await idempotencyService.markAsProcessed(eventId);
        logger.info(
          `[IMAGE_MIGRATION] Imagen optimizada correctamente eventId=${eventId} ` +
            `s3Key=${result.s3Key} savings=${result.savingsPercent}%`,
        );

        // 3. Reply opcional a NestJS
        if (message.replyToQueueUrl) {
          const replyPayload = {
            eventId: message.eventId,
            status: "SUCCESS" as const,
            data: {
              s3Key: result.s3Key,
              newUrl: result.newUrl,
              savingsPercent: result.savingsPercent,
            },
          };

          await replyService.sendReply(
            message.replyToQueueUrl,
            message.eventId,
            replyPayload,
          );
        }
      } else {
        logger.error(
          `[IMAGE_MIGRATION] Fallo optimizando imagen eventId=${eventId} error=${result.error}`,
        );
        // Liberar lock para que SQS pueda reintentar
        await idempotencyService.releaseLock(eventId);
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    } catch (e) {
      logger.error(`[IMAGE_MIGRATION] Error inesperado eventId=${eventId}:`, e);
      // Liberar lock en caso de error inesperado para evitar deadlocks
      if (lockAcquired) {
        await idempotencyService.releaseLock(eventId);
      }
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
};
