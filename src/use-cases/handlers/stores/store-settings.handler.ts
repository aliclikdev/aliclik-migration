// src/use-cases/handlers/stores/store-settings.handler.ts

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
      currency_code: settings.currencyCode ?? "PEN",
      timezone: settings.timezone ?? "America/Lima",
      config: settings.config ?? null,
      support_phone: settings.supportPhone ?? null,
      support_email: settings.supportEmail ?? null,
      is_email_transfer_verified: settings.isEmailTransferVerified ?? false,
      account_verified: settings.accountVerified ?? false,
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
      // ============================================
      // 1. BUSCAR O CREAR LA TIENDA
      // ============================================

      // ✅ CORREGIDO: Buscar store por legacy_store_id (bigint)
      let storeRecord = await tx.stores.findFirst({
        where: { legacy_store_id: BigInt(store.legacyStoreId!) },
        select: {
          id: true,
          name: true,
          business_name: true,
          ruc: true,
          logo_url: true,
          is_active: true,
          country_id: true,
          ubigeo_id: true,
          address: true,
          timezone: true,
          currency_code: true,
        },
      });

      if (!storeRecord) {
        logger.warn(
          `[STORE_SETTINGS] Tienda legacy ${store.legacyStoreId} no encontrada. Creándola...`,
        );

        // ✅ CORREGIDO: Obtener país por defecto (bigint)
        const defaultCountryId = catalog.countries["PER"];
        if (!defaultCountryId) {
          throw new Error(
            `[STORE_SETTINGS] País por defecto "PER" no encontrado en catálogo.`,
          );
        }

        // ✅ CORREGIDO: Crear store con bigint
        storeRecord = await tx.stores.create({
          data: {
            legacy_store_id: BigInt(store.legacyStoreId!),
            name: store.name || `Tienda Legacy ${store.legacyStoreId}`,
            business_name: store.businessName || null,
            ruc: store.ruc || null,
            logo_url: store.logoUrl || null,
            is_active: store.isActive ?? true,
            currency_code: "PEN",
            timezone: "America/Lima",
            country_id: defaultCountryId, // ✅ bigint
            // ubigeo_id: null por defecto
          },
          select: {
            id: true,
            name: true,
            business_name: true,
            ruc: true,
            logo_url: true,
            is_active: true,
            country_id: true,
            ubigeo_id: true,
            address: true,
            timezone: true,
            currency_code: true,
          },
        });

        logger.info(
          `[STORE_SETTINGS] Tienda creada: ${storeRecord.name} (id: ${storeRecord.id})`,
        );
      } else {
        logger.info(
          `[STORE_SETTINGS] Tienda encontrada: ${storeRecord.name} (id: ${storeRecord.id})`,
        );

        // ✅ CORREGIDO: Actualizar datos de la tienda si es necesario
        const storeUpdateData: any = {
          updated_at: new Date(),
        };

        if (store.name !== undefined && store.name !== storeRecord.name) {
          storeUpdateData.name = store.name;
        }
        if (
          store.businessName !== undefined &&
          store.businessName !== storeRecord.business_name
        ) {
          storeUpdateData.business_name = store.businessName;
        }
        if (store.ruc !== undefined && store.ruc !== storeRecord.ruc) {
          storeUpdateData.ruc = store.ruc;
        }
        if (
          store.logoUrl !== undefined &&
          store.logoUrl !== storeRecord.logo_url
        ) {
          storeUpdateData.logo_url = store.logoUrl;
        }
        if (store.isActive !== undefined) {
          storeUpdateData.is_active = store.isActive;
        }

        if (Object.keys(storeUpdateData).length > 1) {
          // Más de solo 'updated_at'
          await tx.stores.update({
            where: { id: storeRecord.id },
            data: storeUpdateData,
          });
          logger.info(
            `[STORE_SETTINGS] Datos de tienda actualizados: ${storeRecord.id}`,
          );
        }
      }

      // ============================================
      // 2. CREAR O ACTUALIZAR STORE SETTINGS
      // ============================================

      if (store.settings) {
        logger.info(
          `[STORE_SETTINGS] Actualizando/Creando settings para store_id: ${storeRecord.id}`,
        );

        // ✅ CORREGIDO: store_id es bigint
        const settingsData = this.buildStoreSettingsData(store.settings);

        await tx.store_settings.upsert({
          where: { store_id: storeRecord.id }, // ✅ bigint
          create: {
            store_id: storeRecord.id, // ✅ bigint
            ...settingsData,
          },
          update: {
            ...settingsData,
            updated_at: new Date(),
          },
        });

        logger.info(
          `[STORE_SETTINGS] Settings actualizados para store_id: ${storeRecord.id}`,
        );
      } else {
        logger.info(
          `[STORE_SETTINGS] No hay settings para actualizar en store_id: ${storeRecord.id}`,
        );
      }
    });

    logger.info(
      `[STORE_SETTINGS] Configuración procesada exitosamente para tienda legacy: ${store.legacyStoreId}`,
    );
  }
}
