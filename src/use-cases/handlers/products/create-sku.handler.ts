import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { SkuMigrationMessage } from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";

export class CreateSkuHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: SkuMigrationMessage): Promise<void> {
    const { sku, eventId } = payload;

    if (!sku.skuCode?.trim()) {
      throw new Error("[CREATE_SKU] El skuCode es requerido.");
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Resolver producto padre
      const product = await tx.products.findFirst({
        where: {
          legacy_product_id: sku.legacyProductId
            ? BigInt(sku.legacyProductId)
            : undefined,
        },
        select: { id: true, store_id: true },
      });

      if (!product) {
        throw new Error(
          `[CREATE_SKU] Producto no encontrado con legacyProductId: ${sku.legacyProductId}`,
        );
      }

      // 2. Upsert del SKU
      const skuRecord = await tx.skus.upsert({
        where: {
          product_id_sku_code: {
            product_id: product.id,
            sku_code: sku.skuCode.trim(),
          },
        },
        update: {
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          stock_min: sku.stockMin ?? 0,
          stock_max: sku.stockMax ?? 0,
          is_active: true,
          updated_at: new Date(),
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
        },
        create: {
          id: randomUUID(),
          store_id: product.store_id,
          product_id: product.id,
          sku_code: sku.skuCode.trim(),
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          stock_min: sku.stockMin ?? 0,
          stock_max: sku.stockMax ?? 0,
          is_active: true,
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
        },
        select: { id: true },
      });

      logger.info(
        `[CREATE_SKU] SKU "${sku.skuCode}" procesado (id: ${skuRecord.id})`,
      );

      // 3. Relacionar SKU con opciones de variante (sku_variant_options)
      // 3. Relacionar SKU con opciones de variante (sku_variant_options)
      if (sku.variantOptions && sku.variantOptions.length > 0) {
        for (const voRef of sku.variantOptions) {
          let variantOptionId: string | null = null;

          // Opción A: Ya tenemos el UUID del nuevo sistema
          if (voRef.variantOptionId) {
            variantOptionId = voRef.variantOptionId;
          }
          // Opción B: Resolver por legacyOptionId
          else if (voRef.legacyOptionId) {
            // ✅ Buscar directamente la variant_option por legacy_option_id
            const optionRecord = await tx.variant_options.findFirst({
              where: {
                legacy_option_id: BigInt(voRef.legacyOptionId),
              },
              select: { id: true },
            });

            if (optionRecord) {
              variantOptionId = optionRecord.id;
            } else {
              logger.warn(
                `[CREATE_SKU] variant_option con legacyOptionId ${voRef.legacyOptionId} no encontrado. Se omite la relación.`,
              );
              continue;
            }
          }

          if (variantOptionId) {
            // Crear relación en sku_variant_options
            const existingSkuOption = await tx.sku_variant_options.findFirst({
              where: {
                sku_id: skuRecord.id,
                variant_option_id: variantOptionId,
              },
              select: { id: true },
            });

            if (!existingSkuOption) {
              await tx.sku_variant_options.create({
                data: {
                  id: randomUUID(),
                  sku_id: skuRecord.id,
                  variant_option_id: variantOptionId,
                },
              });
            }
          }
        }

        logger.info(
          `[CREATE_SKU] ${sku.variantOptions.length} relaciones variant_option procesadas para SKU ${skuRecord.id}`,
        );
      }
    });

    logger.info(`[CREATE_SKU] Evento completado exitosamente: ${eventId}`);
  }
}
