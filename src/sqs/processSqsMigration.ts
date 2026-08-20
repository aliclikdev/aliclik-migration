// src/sqs/processSqsMigration.ts
import { SQSHandler } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { SqsMigrationUseCase } from "../use-cases/sqs-migration.use-case";
import { IdempotencyService } from "../services/idempotency.service";
import { SqsReplyService } from "../services/sqs-reply.service";
import { UserMigrationMessage } from "../types/sqs-migration.types";
import { logger } from "../utils/logger";
import { randomUUID } from "crypto";

// Inicialización fuera del handler para reutilizar conexiones en Lambda
const prisma = new PrismaClient();
const idempotencyService = new IdempotencyService(prisma);
const sqsReplyService = new SqsReplyService();
const migrationUseCase = new SqsMigrationUseCase(prisma, idempotencyService);

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      // Parseamos el payload y aseguramos un eventId único combinando el messageId de SQS
      const payload: UserMigrationMessage = JSON.parse(record.body);
      payload.eventId =
        `${payload.eventId}-${randomUUID()}` || record.messageId;

      // Ejecutamos la lógica de migración
      const result = await migrationUseCase.execute(payload);

      // Si es una consulta (GET_USER) y tenemos resultado + cola de respuesta, enviamos la respuesta
      if (
        payload.eventType === "GET_USER" &&
        result &&
        payload.replyToQueueUrl
      ) {
        await sqsReplyService.sendReply(
          payload.replyToQueueUrl,
          payload.eventId,
          result,
        );
      }
    } catch (error) {
      // En Lambda con SQS, lanzar el error hace que SQS reintente o lo envíe a la DLQ
      logger.error(
        `[HANDLER] Error procesando registro SQS ${record.messageId}:`,
        error,
      );
      throw error;
    }
  }
};
