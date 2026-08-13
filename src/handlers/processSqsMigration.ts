// src/handlers/processSqsMigration.ts
import { SQSEvent, Context } from 'aws-lambda';
import { executeSqsMigration } from '../use-cases/sqs-migration.use-case';
import { logger } from '../utils/logger';
import { getCatalogCache } from '../utils/catalog';

export const handler = async (event: SQSEvent, context: Context) => {
  logger.info('📦 Procesando mensajes SQS', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  // Warmup: cargar catálogos en memoria
  await getCatalogCache();

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      
      // Validar estructura básica del mensaje
      if (!message.eventId || !message.eventType) {
        throw new Error('Mensaje inválido: faltan campos obligatorios');
      }

      await executeSqsMigration(message);
      
      logger.info('✅ Mensaje procesado exitosamente', {
        eventId: message.eventId,
        eventType: message.eventType,
        messageId: record.messageId,
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      
      logger.error('❌ Error procesando mensaje', {
        messageId: record.messageId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        body: record.body,
      });

      // Marcar este mensaje como fallido para que SQS lo reintente o envíe a DLQ
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  // Si hay fallos, SQS reintentará los mensajes fallidos según la política
  return {
    batchItemFailures,
  };
};