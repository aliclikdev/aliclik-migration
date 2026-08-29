// src/use-cases/handlers/products/create-product-variant.handler.ts

import { PrismaClient, Prisma } from "@prisma/client";
import { ProductVariantMigrationMessage } from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";

export class CreateProductVariantHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: ProductVariantMigrationMessage): Promise<void> {
    const { variant, eventId } = payload;

    if (!variant.name?.trim()) {
      throw new Error(
        "[CREATE_PRODUCT_VARIANT] El nombre de la variante es requerido.",
      );
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // ✅ CORREGIDO: Buscar producto por legacy_product_id (BIGINT)
      const product = await tx.product.findFirst({
        where: {
          legacy_product_id: variant.legacyProductId
            ? BigInt(variant.legacyProductId)
            : undefined,
        },
        select: { id: true, store_id: true },
      });

      if (!product) {
        throw new Error(
          `[CREATE_PRODUCT_VARIANT] Producto no encontrado con legacyProductId: ${variant.legacyProductId}`,
        );
      }

      // ✅ CORREGIDO: Buscar variante existente con BIGINT
      let variantRecord = await tx.productVariant.findFirst({
        where: {
          product_id: product.id,
          legacy_variant_id: variant.legacyVariantId
            ? BigInt(variant.legacyVariantId)
            : null,
        },
        select: { id: true },
      });

      const variantData = {
        name: variant.name.trim(),
        product_id: product.id,
        legacy_variant_id: variant.legacyVariantId
          ? BigInt(variant.legacyVariantId)
          : null,
      };

      if (variantRecord) {
        variantRecord = await tx.productVariant.update({
          where: { id: variantRecord.id },
          data: variantData,
        });
      } else {
        variantRecord = await tx.productVariant.create({
          data: variantData,
        });
      }

      logger.info(
        `[CREATE_PRODUCT_VARIANT] Variante "${variant.name}" procesada (id: ${variantRecord.id})`,
      );

      // ✅ CORREGIDO: Procesar opciones con BIGINTs
      if (variant.options && variant.options.length > 0) {
        for (const option of variant.options) {
          if (!option.name?.trim()) continue;

          const optionRecord = await tx.variantOption.findFirst({
            where: {
              variant_id: variantRecord.id,
              legacy_option_id: option.legacyOptionId
                ? BigInt(option.legacyOptionId)
                : null,
            },
            select: { id: true },
          });

          if (optionRecord) {
            await tx.variantOption.update({
              where: { id: optionRecord.id },
              data: {
                name: option.name.trim(),
                updated_at: new Date(),
              },
            });
          } else {
            await tx.variantOption.create({
              data: {
                variant_id: variantRecord.id,
                name: option.name.trim(),
                legacy_option_id: option.legacyOptionId
                  ? BigInt(option.legacyOptionId)
                  : null,
              },
            });
          }
        }
        logger.info(
          `[CREATE_PRODUCT_VARIANT] ${variant.options.length} opciones procesadas para variante ${variantRecord.id}`,
        );
      }
    });

    logger.info(
      `[CREATE_PRODUCT_VARIANT] Evento completado exitosamente: ${eventId}`,
    );
  }
}
