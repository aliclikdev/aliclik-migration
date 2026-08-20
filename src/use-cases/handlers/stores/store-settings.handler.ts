// src/use-cases/handlers/users/create-user.handler.ts
import { PrismaClient } from "@prisma/client";
import {
  StoreWithDetails,
  UserMigrationMessage,
} from "../../../types/sqs-migration.types";
import { getCatalogCache } from "../../../utils/catalog";
import { logger } from "../../../utils/logger";

export class StoreSettingsHandler {
  constructor(private readonly prisma: PrismaClient) {}

  private buildStoreSettingsData(
    settings: NonNullable<StoreWithDetails["settings"]>,
  ) {
    return {
      currency_code: settings.currencyCode,
      timezone: settings.timezone,
      config: settings.config,
      support_phone: settings.supportPhone,
      support_email: settings.supportEmail,
      is_email_transfer_verified: settings.isEmailTransferVerified,
      account_verified: settings.accountVerified,
    };
  }

  async execute(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const { store } = payload;

    if (!store?.legacyStoreId) {
      throw new Error("[STORE_SETTINGS] Se requiere store.legacyStoreId");
    }

    logger.info(
      `[STORE_SETTINGS] Procesando configuración para tienda legacy: ${store.legacyStoreId}`,
    );

    await this.prisma.$transaction(async (tx: any) => {
      // 1. Buscar o Crear Tienda
      let storeRecord = await tx.stores.findFirst({
        where: { legacy_store_id: BigInt(store.legacyStoreId!) },
      });

      if (!storeRecord) {
        logger.warn(
          `[STORE_SETTINGS] Tienda legacy ${store.legacyStoreId} no encontrada. Creándola...`,
        );

        const defaultCountryId = catalog.countries["PER"];
        if (!defaultCountryId) {
          throw new Error(
            `[STORE_SETTINGS] País por defecto "PER" no encontrado en catálogo.`,
          );
        }

        storeRecord = await tx.stores.create({
          data: {
            legacy_store_id: BigInt(store.legacyStoreId!),
            name: store.name || `Tienda Legacy ${store.legacyStoreId}`, // Fallback seguro
            business_name: store.businessName || null,
            ruc: store.ruc || null,
            logo_url: store.logoUrl || null,
            is_active: store.isActive ?? true,
            currency_code: "PEN",
            timezone: "America/Lima",
            country_id: defaultCountryId,
          },
        });
      }

      // 2. Upsert de Settings (solo si hay settings en el payload)
      if (store.settings) {
        logger.info(
          `[STORE_SETTINGS] Actualizando/Creando settings para store_id: ${storeRecord.id}`,
        );

        const settingsData = this.buildStoreSettingsData(store.settings);

        await tx.store_settings.upsert({
          where: { store_id: storeRecord.id },
          create: {
            store_id: storeRecord.id,
            ...settingsData,
          },
          update: {
            ...settingsData,
          },
        });
      }
    });

    logger.info(
      `[STORE_SETTINGS] Configuración procesada exitosamente para tienda legacy: ${store.legacyStoreId}`,
    );
  }
}
