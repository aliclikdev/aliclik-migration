// src/use-cases/sqs-migration.use-case.ts
import { PrismaClient } from "@prisma/client";
import { IdempotencyService } from "../services/idempotency.service";
import {
  ProductMigrationMessage,
  SqsMigrationMessage,
  UserMigrationMessage,
  UserMigrationResponse,
} from "../types/sqs-migration.types";
import { logger } from "../utils/logger";

// Importar los nuevos handlers
import { CreateUserHandler } from "./handlers/users/create-user.handler";
import { UpdateUserHandler } from "./handlers/users/update-user.handler";
import { DeleteUserHandler } from "./handlers/users/delete-user.handler";
import { GetUserHandler } from "./handlers/users/get-user.handler";
import { StoreSettingsHandler } from "./handlers/stores/store-settings.handler";
import { CreateProductHandler } from "./handlers/products/create-product.handler";

export class SqsMigrationUseCase {
  private readonly createUser: CreateUserHandler;
  private readonly updateUser: UpdateUserHandler;
  private readonly deleteUser: DeleteUserHandler;
  private readonly getUser: GetUserHandler;
  private readonly storeSettings: StoreSettingsHandler;
  private readonly createProduct: CreateProductHandler;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotencyService: IdempotencyService,
  ) {
    // Instanciar handlers pasando las dependencias
    this.createUser = new CreateUserHandler(this.prisma);
    this.updateUser = new UpdateUserHandler(this.prisma);
    this.deleteUser = new DeleteUserHandler(this.prisma);
    this.getUser = new GetUserHandler(this.prisma, this.createUser);
    this.storeSettings = new StoreSettingsHandler(this.prisma);
    this.createProduct = new CreateProductHandler(this.prisma);
  }

  async execute(
    payload: SqsMigrationMessage,
  ): Promise<UserMigrationResponse | void> {
    const { eventId, eventType } = payload;
    logger.info(
      `[SQS_MIGRATION] Procesando evento: ${eventId} | Tipo: ${eventType}`,
    );

    const isMutation = [
      "CREATE_USER",
      "UPDATE_USER",
      "DELETE_USER",
      "ACCEPT_TERMS",
      "STORE_SETTINGS",
      "CREATE_PRODUCT",
    ].includes(eventType);
    let lockAcquired = false;

    if (isMutation) {
      lockAcquired = await this.idempotencyService.acquireLock(eventId);
      if (!lockAcquired) {
        logger.warn(
          `[SQS_MIGRATION] Evento omitido por idempotencia: ${eventId}`,
        );
        return;
      }
    }

    try {
      let result: UserMigrationResponse | void = undefined;

      const userPayload = payload as UserMigrationMessage;
      const productPayload = payload as ProductMigrationMessage;

      switch (eventType) {
        case "CREATE_USER":
          await this.createUser.execute(userPayload);
          break;
        case "UPDATE_USER":
          await this.updateUser.execute(userPayload);
          break;
        case "DELETE_USER":
          await this.deleteUser.execute(userPayload);
          break;
        case "GET_USER":
          result = await this.getUser.execute(userPayload);
          break;
        case "STORE_SETTINGS":
          await this.storeSettings.execute(userPayload);
          break;
        case "CREATE_PRODUCT":
          await this.createProduct.execute(productPayload);
          break;
        default:
          logger.warn(
            `[SQS_MIGRATION] Tipo de evento no soportado: ${eventType}`,
          );
      }

      if (isMutation) {
        await this.idempotencyService.markAsProcessed(eventId);
      }

      logger.info(
        `[SQS_MIGRATION] Evento completado con éxito: ${eventId || (result || {}).eventId}`,
      );
      return result;
    } catch (error) {
      logger.error(
        `[SQS_MIGRATION] Error procesando evento ${eventId}:`,
        error,
      );
      if (isMutation && lockAcquired) {
        await this.idempotencyService.releaseLock(eventId);
      }
      throw error;
    }
  }
}
