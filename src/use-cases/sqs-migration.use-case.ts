import { PrismaClient } from "@prisma/client";
import { IdempotencyService } from "../services/idempotency.service";
import {
  ProductMigrationMessage,
  ProductVariantMigrationMessage,
  SkuMigrationMessage,
  SqsMigrationMessage,
  UserMigrationMessage,
  UserMigrationResponse,
} from "../types/sqs-migration.types";
import { logger } from "../utils/logger";

// Importar todos los handlers
import { CreateUserHandler } from "./handlers/users/create-user.handler";
import { UpdateUserHandler } from "./handlers/users/update-user.handler";
import { DeleteUserHandler } from "./handlers/users/delete-user.handler";
import { GetUserHandler } from "./handlers/users/get-user.handler";
import { StoreSettingsHandler } from "./handlers/stores/store-settings.handler";
import { CreateProductHandler } from "./handlers/products/create-product.handler";
import { CreateProductVariantHandler } from "./handlers/products/create-product-variant.handler";
import { CreateSkuHandler } from "./handlers/products/create-sku.handler";

export class SqsMigrationUseCase {
  private readonly createUser: CreateUserHandler;
  private readonly updateUser: UpdateUserHandler;
  private readonly deleteUser: DeleteUserHandler;
  private readonly getUser: GetUserHandler;
  private readonly storeSettings: StoreSettingsHandler;
  private readonly createProduct: CreateProductHandler;
  private readonly createProductVariant: CreateProductVariantHandler;
  private readonly createSku: CreateSkuHandler;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotencyService: IdempotencyService,
  ) {
    this.createUser = new CreateUserHandler(this.prisma);
    this.updateUser = new UpdateUserHandler(this.prisma);
    this.deleteUser = new DeleteUserHandler(this.prisma);
    this.getUser = new GetUserHandler(this.prisma, this.createUser);
    this.storeSettings = new StoreSettingsHandler(this.prisma);
    this.createProduct = new CreateProductHandler(this.prisma);
    this.createProductVariant = new CreateProductVariantHandler(this.prisma);
    this.createSku = new CreateSkuHandler(this.prisma);
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
      "CREATE_PRODUCT_VARIANT",
      "CREATE_SKU",
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

      // ✅ CORRECCIÓN: El switch actúa como type guard natural
      switch (eventType) {
        case "CREATE_USER": {
          // TypeScript infiere que es UserMigrationMessage
          await this.createUser.execute(payload as UserMigrationMessage);
          break;
        }
        case "UPDATE_USER": {
          await this.updateUser.execute(payload as UserMigrationMessage);
          break;
        }
        case "DELETE_USER": {
          await this.deleteUser.execute(payload as UserMigrationMessage);
          break;
        }
        case "GET_USER": {
          result = await this.getUser.execute(payload as UserMigrationMessage);
          break;
        }
        case "ACCEPT_TERMS":
        case "STORE_SETTINGS": {
          await this.storeSettings.execute(payload as UserMigrationMessage);
          break;
        }
        case "CREATE_PRODUCT": {
          // TypeScript infiere que es ProductMigrationMessage
          await this.createProduct.execute(payload as ProductMigrationMessage);
          break;
        }
        case "CREATE_PRODUCT_VARIANT": {
          // TypeScript infiere que es ProductVariantMigrationMessage
          await this.createProductVariant.execute(
            payload as ProductVariantMigrationMessage,
          );
          break;
        }
        case "CREATE_SKU": {
          // TypeScript infiere que es SkuMigrationMessage
          await this.createSku.execute(payload as SkuMigrationMessage);
          break;
        }
        default:
          logger.warn(
            `[SQS_MIGRATION] Tipo de evento no soportado: ${eventType}`,
          );
      }

      if (isMutation) {
        await this.idempotencyService.markAsProcessed(eventId);
      }

      logger.info(
        `[SQS_MIGRATION] Evento completado con éxito: ${eventId || (result as any)?.eventId}`,
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
