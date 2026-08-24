import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import {
  ProductCatalogPayload,
  ProductCategoryPayload,
  ProductImagePayload,
  ProductMigrationMessage,
} from "../../../types/sqs-migration.types";
import { getCatalogCache } from "../../../utils/catalog";
import { logger } from "../../../utils/logger";

export class CreateProductHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: ProductMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const { product, skus, images, eventId } = payload;

    if (!skus || skus.length === 0) {
      throw new Error("[CREATE_PRODUCT] Se requiere al menos un SKU.");
    }

    // ✅ CORRECCIÓN: productStatuses es un Record<string, string>, no un array
    const statusId = product.statusCode
      ? catalog.productStatuses[product.statusCode]
      : undefined;

    if (product.statusCode && !statusId) {
      throw new Error(
        `[CREATE_PRODUCT] Status "${product.statusCode}" no encontrado en catálogo product_statuses.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Resolver Store
      const storeId = await this.resolveStore(tx, product.storeLegacyId);

      // 2. Resolver Categoría
      const categoryId = await this.resolveCategory(
        tx,
        storeId,
        product.category,
      );

      // 3. Resolver Catálogo
      const catalogId = await this.resolveCatalog(tx, storeId, product.catalog);

      // 4. Upsert Producto
      let productRecord = await tx.products.findFirst({
        where: {
          legacy_product_id: product.legacyProductId
            ? BigInt(product.legacyProductId)
            : undefined,
        },
        select: { id: true },
      });

      const productData = {
        name: product.name,
        short_description: product.shortDescription ?? null,
        large_description: product.largeDescription ?? null,
        description: product.description ?? null,
        url_image: product.urlImage ?? null,
        is_novelty: product.isNovelty ?? false,
        is_validate: product.isValidate ?? false,
        is_registered_product: product.isRegisteredProduct ?? false,
        retail_price_suggested: product.retailPriceSuggested ?? 0,
        is_active: product.isActive ?? true,
        store_id: storeId,
        category_id: categoryId,
        catalog_id: catalogId,
        status_id: statusId ?? null,
      };

      if (productRecord) {
        productRecord = await tx.products.update({
          where: { id: productRecord.id },
          data: productData,
        });
      } else {
        productRecord = await tx.products.create({
          data: {
            id: randomUUID(),
            legacy_product_id: product.legacyProductId
              ? BigInt(product.legacyProductId)
              : null,
            ...productData,
          },
        });
      }

      // 5. Upsert SKUs y Warehouse SKUs
      for (const sku of skus) {
        const skuRecord = await tx.skus.upsert({
          where: {
            product_id_sku_code: {
              product_id: productRecord.id,
              sku_code: sku.skuCode,
            },
          },
          update: {
            ean: sku.ean ?? null,
            regular_price: sku.regularPrice,
            sales_price: sku.salesPrice,
            purchase_price: sku.purchasePrice,
            legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
            is_active: sku.isActive ?? true,
          },
          create: {
            id: randomUUID(),
            store_id: storeId,
            product_id: productRecord.id,
            sku_code: sku.skuCode,
            ean: sku.ean ?? null,
            regular_price: sku.regularPrice,
            sales_price: sku.salesPrice,
            purchase_price: sku.purchasePrice,
            legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
            is_active: sku.isActive ?? true,
          },
        });

        // ✅ CORRECCIÓN: warehouseSkus (camelCase) + sku_id_warehouse_id (nombre del compound unique)
        if (sku.warehouseSkus && sku.warehouseSkus.length > 0) {
          for (const ws of sku.warehouseSkus) {
            const warehouseId = await this.resolveWarehouse(
              tx,
              storeId,
              ws.legacyWarehouseId,
            );

            await tx.warehouse_skus.upsert({
              where: {
                // ✅ CORRECCIÓN: El compound unique se accede por nombre generado: sku_id_warehouse_id
                sku_id_warehouse_id: {
                  sku_id: skuRecord.id,
                  warehouse_id: warehouseId,
                },
              },
              update: {
                stock_physical: ws.stockPhysical ?? 0,
                stock_virtual: ws.stockVirtual ?? 0,
                stock_reserved: ws.stockReserved ?? 0,
                legacy_warehouse_sku_id: ws.legacyWarehouseSkuId
                  ? BigInt(ws.legacyWarehouseSkuId)
                  : null,
                updated_at: new Date(),
              },
              create: {
                id: randomUUID(),
                store_id: storeId,
                sku_id: skuRecord.id,
                warehouse_id: warehouseId,
                stock_physical: ws.stockPhysical ?? 0,
                stock_virtual: ws.stockVirtual ?? 0,
                stock_reserved: ws.stockReserved ?? 0,
                legacy_warehouse_sku_id: ws.legacyWarehouseSkuId
                  ? BigInt(ws.legacyWarehouseSkuId)
                  : null,
              },
            });
          }
        }
      }

      // ✅ CORRECCIÓN: productImages (camelCase)
      if (images && images.length > 0) {
        await tx.product_images.createMany({
          data: images.map((img, index) => ({
            id: randomUUID(),
            product_id: productRecord.id,
            url: img.url,
            position: img.position ?? index,
            is_primary: img.isPrimary ?? index === 0,
          })),
          skipDuplicates: true,
        });
      }
    });

    logger.info(
      `[CreateProductHandler] Producto migrado exitosamente: ${eventId}`,
    );
  }

  // --- Helpers de Resolución ---

  private async resolveStore(
    tx: Prisma.TransactionClient,
    storeLegacyId: number,
  ): Promise<string> {
    const store = await tx.stores.findFirst({
      where: { legacy_store_id: BigInt(storeLegacyId) },
      select: { id: true },
    });
    if (!store) {
      throw new Error(`Store no encontrado con legacy_id: ${storeLegacyId}`);
    }
    return store.id;
  }

  private async resolveCategory(
    tx: Prisma.TransactionClient,
    storeId: string,
    category?: ProductCategoryPayload | null,
  ): Promise<string | null> {
    if (!category?.name) return null;

    let cat = await tx.categories.findFirst({
      where: { store_id: storeId, name: category.name },
      select: { id: true },
    });

    if (!cat) {
      cat = await tx.categories.create({
        data: {
          id: randomUUID(),
          store_id: storeId,
          name: category.name,
          is_active: true,
        },
        select: { id: true },
      });
    }
    return cat.id;
  }

  private async resolveCatalog(
    tx: Prisma.TransactionClient,
    storeId: string,
    catalog?: ProductCatalogPayload | null,
  ): Promise<string | null> {
    if (!catalog?.name) return null;

    let cat = await tx.catalogs.findFirst({
      where: { store_id: storeId, name: catalog.name },
      select: { id: true },
    });

    if (!cat) {
      cat = await tx.catalogs.create({
        data: {
          id: randomUUID(),
          store_id: storeId,
          name: catalog.name,
          is_public: false,
          is_active: true,
        },
        select: { id: true },
      });
    }
    return cat.id;
  }

  private async resolveWarehouse(
    tx: Prisma.TransactionClient,
    storeId: string,
    legacyWarehouseId: number,
  ): Promise<string> {
    let warehouse = await tx.warehouses.findFirst({
      where: {
        store_id: storeId,
        legacy_id: BigInt(legacyWarehouseId),
      },
      select: { id: true },
    });

    if (!warehouse) {
      warehouse = await tx.warehouses.findFirst({
        where: { store_id: storeId, is_active: true },
        orderBy: { created_at: "asc" },
        select: { id: true },
      });
    }

    if (!warehouse) {
      throw new Error(
        `No se encontró warehouse para store ${storeId} con legacy_id ${legacyWarehouseId}`,
      );
    }

    return warehouse.id;
  }
}
