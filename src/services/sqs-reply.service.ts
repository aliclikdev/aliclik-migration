import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { UserMigrationResponse } from '../types/sqs-migration.types';
import { logger } from '../utils/logger';

export class SqsReplyService {
  private sqsClient: SQSClient;

  constructor() {
    this.sqsClient = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async sendReply(
    targetQueueUrl: string,
    correlationId: string,
    payload: UserMigrationResponse
  ): Promise<void> {
    try {
      const command = new SendMessageCommand({
        QueueUrl: targetQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageAttributes: {
          CorrelationId: {
            DataType: 'String',
            StringValue: correlationId,
          },
        },
      });

      await this.sqsClient.send(command);
      logger.info(`[SQS_REPLY] Respuesta enviada con éxito. CorrelationId: ${correlationId}`);
    } catch (error) {
      logger.error(`[SQS_REPLY] Error al enviar respuesta a la cola ${targetQueueUrl}:`, error);
      throw error;
    }
  }
}