import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
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
    await this.prisma.$transaction(async (tx) => {
      const productRecord = await tx.products.findFirst({
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
      const storeId: string = productRecord.store_id;

      const skuRecord = await tx.skus.upsert({
        where: {
          sku_code_store_id: {
            sku_code: sku.skuCode,
            store_id: storeId,
          },
        },
        update: {
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          stock_min: sku.stockMin ?? 0,
          stock_max: sku.stockMax ?? 0,
          is_active: sku.isActive ?? true,
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
          updated_at: new Date(),
        },
        create: {
          id: randomUUID(),
          store_id: storeId,
          product_id: productRecord.id,
          sku_code: sku.skuCode,
          ean: sku.ean ?? null,
          regular_price: sku.regularPrice ?? 0,
          sales_price: sku.salesPrice ?? 0,
          purchase_price: sku.purchasePrice ?? 0,
          stock_min: sku.stockMin ?? 0,
          stock_max: sku.stockMax ?? 0,
          is_active: sku.isActive ?? true,
          legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
        },
      });

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
          await tx.warehouse_skus.upsert({
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
              id: randomUUID(),
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
        }
      }

      if (sku.variantOptions && sku.variantOptions.length > 0) {
        for (const variantOpt of sku.variantOptions) {
          const optionId = await this.resolveOrCreateOption(
            tx,
            storeId,
            productRecord.id,
            variantOpt,
          );
          if (optionId) {
            await tx.sku_variant_options.upsert({
              where: {
                sku_id_variant_option_id: {
                  sku_id: skuRecord.id,
                  variant_option_id: optionId,
                },
              },
              update: {},
              create: {
                id: randomUUID(),
                sku_id: skuRecord.id,
                variant_option_id: optionId,
              },
            });
            logger.info(`[CREATE_SKU] Opción vinculada al SKU: ${optionId}`);
          }
        }
      }
    });
    logger.info(
      `[CreateSkuHandler] SKU y stocks migrados exitosamente: ${eventId} (${sku.skuCode})`,
    );
  }

  private async resolveOrCreateWarehouse(
    tx: Prisma.TransactionClient,
    storeId: string,
    legacyWarehouseId: number,
    warehouseName?: string,
  ): Promise<string> {
    let warehouse = await tx.warehouses.findFirst({
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
      const newWarehouse = await tx.warehouses.create({
        data: {
          id: randomUUID(),
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
      // El warehouse ya existe pero el nombre llegó actualizado desde el legacy: lo sincronizamos.
      await tx.warehouses.update({
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
    storeId: string,
    productId: string,
    ref: SkuVariantOptionRef,
  ): Promise<string | null> {
    let optionId: string | null = null;
    if (ref.legacyOptionId) {
      const optionByLegacy = await tx.variant_options.findFirst({
        where: { legacy_option_id: BigInt(ref.legacyOptionId) },
        select: { id: true },
      });
      if (optionByLegacy) optionId = optionByLegacy.id;
    }
    if (!optionId && ref.name) {
      const optionByName = await tx.variant_options.findFirst({
        where: { name: ref.name },
        select: { id: true },
      });
      if (optionByName) optionId = optionByName.id;
    }
    if (!optionId && ref.name) {
      const createdOption = await tx.variant_options.create({
        data: {
          id: randomUUID(),
          name: ref.name,
          legacy_option_id: ref.legacyOptionId
            ? BigInt(ref.legacyOptionId)
            : null,
          is_active: true,
        },
        select: { id: true },
      });
      optionId = createdOption.id;
      logger.info(
        `[CREATE_SKU] Opción creada: ${ref.name} (legacy: ${ref.legacyOptionId})`,
      );
    }
    if (!optionId) {
      logger.warn(
        `[CREATE_SKU] No se pudo resolver la opción: legacy=${ref.legacyOptionId}, name=${ref.name}`,
      );
    }
    return optionId;
  }
}
