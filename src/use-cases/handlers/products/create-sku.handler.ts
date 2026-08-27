// src/use-cases/handlers/products/create-sku.handler.ts

import { PrismaClient, Prisma } from "@prisma/client";
import {
  SkuMigrationMessage,
  SkuVariantOptionRef,
} from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";

export class CreateSkuHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: SkuMigrationMessage): Promise<void> {
    const { sku, eventId } = payload;

    if (!sku.skuCode) {
      throw new Error("[CREATE_SKU] El código SKU es obligatorio.");
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // ============================================
      // 1. BUSCAR PRODUCTO PADRE
      // ============================================

      const productRecord = await tx.product.findFirst({
        where: {
          legacy_product_id: sku.legacyProductId
            ? BigInt(sku.legacyProductId)
            : undefined,
        },
        select: { id: true, store_id: true },
      });

      if (!productRecord) {
        throw new Error(
          `[CREATE_SKU] Producto padre no encontrado con legacy_id: ${sku.legacyProductId}. Asegúrese de procesar primero el evento CREATE_PRODUCT.`,
        );
      }

      if (!productRecord.store_id) {
        throw new Error(
          `[CREATE_SKU] El producto padre (legacy_id: ${sku.legacyProductId}) no tiene store_id asignado.`,
        );
      }

      const storeId: bigint = productRecord.store_id;

      // ============================================
      // 2. CREAR O ACTUALIZAR SKU
      // ============================================

      // ✅ CORREGIDO: Usar 'store_id_sku_code' en lugar de 'sku_code_store_id'
      const skuRecord = await tx.sku.upsert({
        where: {
          store_id_sku_code: {
            store_id: storeId,
            sku_code: sku.skuCode,
          },
        },
        update: {
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          drop_price: sku.dropPrice ?? null,
          height_cm: sku.heightCm ?? null,
          width_cm: sku.widthCm ?? null,
          length_cm: sku.lengthCm ?? null,
          weight_kg: sku.weightKg ?? null,
          stock_min: sku.stockMin ?? 5,
          stock_max: sku.stockMax ?? 100,
          track_stock: sku.trackStock ?? true,
          allow_backorder: sku.allowBackorder ?? false,
          is_active: sku.isActive ?? true,
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
          updated_at: new Date(),
        },
        create: {
          store_id: storeId,
          product_id: productRecord.id,
          sku_code: sku.skuCode,
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          drop_price: sku.dropPrice ?? null,
          height_cm: sku.heightCm ?? null,
          width_cm: sku.widthCm ?? null,
          length_cm: sku.lengthCm ?? null,
          weight_kg: sku.weightKg ?? null,
          stock_min: sku.stockMin ?? 5,
          stock_max: sku.stockMax ?? 100,
          track_stock: sku.trackStock ?? true,
          allow_backorder: sku.allowBackorder ?? false,
          is_active: sku.isActive ?? true,
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
        },
      });

      logger.info(
        `[CREATE_SKU] SKU procesado: ${sku.skuCode} (id: ${skuRecord.id})`,
      );

      // ============================================
      // 3. PROCESAR STOCKS POR ALMACÉN
      // ============================================

      if (sku.warehouseStocks && sku.warehouseStocks.length > 0) {
        for (const whStock of sku.warehouseStocks) {
          if (!whStock.legacyWarehouseId) {
            logger.warn(
              `[CREATE_SKU] warehouseStock sin legacyWarehouseId, se omite: ${JSON.stringify(whStock)}`,
            );
            continue;
          }

          const warehouseId = await this.resolveOrCreateWarehouse(
            tx,
            storeId,
            whStock.legacyWarehouseId,
            whStock.warehouseName,
          );

          await tx.warehouseSku.upsert({
            where: {
              sku_id_warehouse_id: {
                sku_id: skuRecord.id,
                warehouse_id: warehouseId,
              },
            },
            update: {
              stock_physical: whStock.stockPhysical ?? 0,
              stock_virtual: whStock.stockVirtual ?? 0,
              stock_reserved: whStock.stockReserved ?? 0,
              updated_at: new Date(),
            },
            create: {
              legacy_warehouse_sku_id: whStock.legacyWarehouseSkuId
                ? BigInt(whStock.legacyWarehouseSkuId)
                : null,
              store_id: storeId,
              sku_id: skuRecord.id,
              warehouse_id: warehouseId,
              stock_physical: whStock.stockPhysical ?? 0,
              stock_virtual: whStock.stockVirtual ?? 0,
              stock_reserved: whStock.stockReserved ?? 0,
            },
          });

          logger.info(
            `[CREATE_SKU] Stock actualizado para warehouse ${warehouseId}: ` +
              `físico=${whStock.stockPhysical ?? 0}, virtual=${whStock.stockVirtual ?? 0}`,
          );
        }
      }

      // ============================================
      // 4. PROCESAR OPCIONES DE VARIANTE
      // ============================================

      if (sku.variantOptions && sku.variantOptions.length > 0) {
        for (const variantOpt of sku.variantOptions) {
          const optionId = await this.resolveOrCreateOption(
            tx,
            productRecord.id,
            variantOpt,
          );

          if (optionId) {
            await tx.skuVariantOption.upsert({
              where: {
                sku_id_variant_option_id: {
                  sku_id: skuRecord.id,
                  variant_option_id: optionId,
                },
              },
              update: {},
              create: {
                sku_id: skuRecord.id,
                variant_option_id: optionId,
              },
            });
            logger.info(`[CREATE_SKU] Opción vinculada al SKU: ${optionId}`);
          } else {
            logger.warn(
              `[CREATE_SKU] No se pudo resolver la opción: ${JSON.stringify(variantOpt)}`,
            );
          }
        }
      }
    });

    logger.info(
      `[CreateSkuHandler] SKU y stocks migrados exitosamente: ${eventId} (${sku.skuCode})`,
    );
  }

  // ============================================
  // MÉTODOS AUXILIARES
  // ============================================

  private async resolveOrCreateWarehouse(
    tx: Prisma.TransactionClient,
    storeId: bigint,
    legacyWarehouseId: number,
    warehouseName?: string,
  ): Promise<bigint> {
    let warehouse = await tx.warehouse.findFirst({
      where: { warehouse_legacy_id: BigInt(legacyWarehouseId) },
      select: { id: true, name: true },
    });

    if (!warehouse) {
      const resolvedName =
        warehouseName?.trim() || `Almacén Legacy ${legacyWarehouseId}`;

      if (!warehouseName?.trim()) {
        logger.warn(
          `[CREATE_SKU] Warehouse legacy ${legacyWarehouseId} no trajo warehouseName; se usará un nombre genérico temporal.`,
        );
      }

      logger.info(
        `[CREATE_SKU] Warehouse legacy ${legacyWarehouseId} no existe. Creándolo automáticamente como "${resolvedName}"...`,
      );

      const newWarehouse = await tx.warehouse.create({
        data: {
          warehouse_legacy_id: BigInt(legacyWarehouseId),
          store_id: storeId,
          name: resolvedName,
          is_active: true,
        },
        select: { id: true },
      });

      warehouse = { id: newWarehouse.id, name: resolvedName };
    } else if (
      warehouseName?.trim() &&
      warehouse.name !== warehouseName.trim()
    ) {
      await tx.warehouse.update({
        where: { id: warehouse.id },
        data: { name: warehouseName.trim() },
      });
      logger.info(
        `[CREATE_SKU] Nombre de warehouse legacy ${legacyWarehouseId} actualizado a "${warehouseName.trim()}".`,
      );
    }

    return warehouse.id;
  }

  private async resolveOrCreateOption(
    tx: Prisma.TransactionClient,
    productId: bigint,
    ref: SkuVariantOptionRef,
  ): Promise<bigint | null> {
    let optionId: bigint | null = null;

    if (ref.legacyOptionId) {
      const optionByLegacy = await tx.variantOption.findFirst({
        where: {
          legacy_option_id: BigInt(ref.legacyOptionId),
        },
        select: { id: true },
      });
      if (optionByLegacy) {
        optionId = optionByLegacy.id;
        logger.info(
          `[CREATE_SKU] Opción encontrada por legacy_option_id: ${ref.legacyOptionId} -> ${optionId}`,
        );
      }
    }

    if (!optionId && ref.name) {
      const optionByName = await tx.variantOption.findFirst({
        where: { name: ref.name },
        select: { id: true },
      });
      if (optionByName) {
        optionId = optionByName.id;
        logger.info(
          `[CREATE_SKU] Opción encontrada por nombre: ${ref.name} -> ${optionId}`,
        );
      }
    }

    if (!optionId && ref.name) {
      logger.info(
        `[CREATE_SKU] Creando nueva opción: ${ref.name} (legacy: ${ref.legacyOptionId})`,
      );

      const createdOption = await tx.variantOption.create({
        data: {
          name: ref.name,
          legacy_option_id: ref.legacyOptionId
            ? BigInt(ref.legacyOptionId)
            : null,
        },
        select: { id: true },
      });
      optionId = createdOption.id;
      logger.info(`[CREATE_SKU] Opción creada: ${ref.name} (id: ${optionId})`);
    }

    if (!optionId) {
      logger.warn(
        `[CREATE_SKU] No se pudo resolver la opción: legacy=${ref.legacyOptionId}, name=${ref.name}`,
      );
    }

    return optionId;
  }
}
