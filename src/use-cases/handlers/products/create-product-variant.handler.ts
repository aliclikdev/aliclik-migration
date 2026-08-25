import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
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

    await this.prisma.$transaction(async (tx) => {
      // 1. Resolver producto padre por legacyProductId
      const product = await tx.products.findFirst({
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

      // 2. Upsert de la variante
      let variantRecord = await tx.product_variants.findFirst({
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
        is_active: true,
        product_id: product.id,
        legacy_variant_id: variant.legacyVariantId
          ? BigInt(variant.legacyVariantId)
          : null,
      };

      if (variantRecord) {
        variantRecord = await tx.product_variants.update({
          where: { id: variantRecord.id },
          data: variantData,
        });
      } else {
        variantRecord = await tx.product_variants.create({
          data: {
            id: randomUUID(),
            ...variantData,
          },
        });
      }

      logger.info(
        `[CREATE_PRODUCT_VARIANT] Variante "${variant.name}" procesada (id: ${variantRecord.id})`,
      );

      // 3. Upsert de las opciones de la variante (Talla, Color, etc.)
      if (variant.options && variant.options.length > 0) {
        for (const option of variant.options) {
          if (!option.name?.trim()) continue;

          const optionRecord = await tx.variant_options.findFirst({
            where: {
              variant_id: variantRecord.id,
              legacy_option_id: option.legacyOptionId
                ? BigInt(option.legacyOptionId)
                : null,
            },
            select: { id: true },
          });

          if (optionRecord) {
            await tx.variant_options.update({
              where: { id: optionRecord.id },
              data: {
                name: option.name.trim(),
                is_active: true,
                updated_at: new Date(),
              },
            });
          } else {
            await tx.variant_options.create({
              data: {
                id: randomUUID(),
                variant_id: variantRecord.id,
                name: option.name.trim(),
                is_active: true,
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
