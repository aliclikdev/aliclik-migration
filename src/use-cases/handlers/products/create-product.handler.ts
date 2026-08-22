// src/use-cases/handlers/products/create-product.handler.ts
import { PrismaClient } from "@prisma/client";
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
    const { product, skus, images } = payload;

    if (!product.storeLegacyId) {
      throw new Error("[CREATE_PRODUCT] Se requiere product.storeLegacyId");
    }

    const storeId = catalog.stores[String(product.storeLegacyId)];
    if (!storeId) {
      throw new Error(
        `[CREATE_PRODUCT] Tienda legacy ${product.storeLegacyId} no encontrada. Migrá la tienda antes que sus productos.`,
      );
    }

    if (!skus || skus.length === 0) {
      throw new Error("[CREATE_PRODUCT] Se requiere al menos un SKU.");
    }

    const statusId = product.statusCode
      ? catalog.productStatuses[product.statusCode]
      : undefined;
    if (product.statusCode && !statusId) {
      throw new Error(
        `[CREATE_PRODUCT] Status "${product.statusCode}" no encontrado en catálogo product_statuses.`,
      );
    }

    logger.info(
      `[CREATE_PRODUCT] Procesando producto legacy: ${product.legacyProductId ?? product.name} de tienda ${storeId}`,
    );

    await this.prisma.$transaction(async (tx: any) => {
      const categoryId = product.category
        ? await this.resolveCategory(tx, storeId, product.category)
        : null;

      const catalogId = product.catalog
        ? await this.resolveCatalog(tx, storeId, product.catalog)
        : null;

      const productData = {
        store_id: storeId,
        category_id: categoryId,
        catalog_id: catalogId,
        name: product.name,
        short_description: product.shortDescription ?? null,
        large_description: product.largeDescription ?? null,
        description: product.description ?? null,
        url_image: product.urlImage ?? null,
        url_reference: product.urlReference ?? null,
        is_product_global: product.isProductGlobal ?? false,
        sale_price_drop: product.salePriceDrop ?? 0,
        price_drop_crate: product.priceDropCrate ?? 0,
        price_drop_dozen: product.priceDropDozen ?? 0,
        retail_price_suggested: product.retailPriceSuggested ?? 0,
        units_crate: product.unitsCrate ?? 0,
        is_novelty: product.isNovelty ?? false,
        is_large_volume: product.isLargeVolume ?? false,
        is_validate: product.isValidate ?? false,
        is_registered_product: product.isRegisteredProduct ?? false,
        ...(statusId && { status_id: statusId }),
        is_active: product.isActive ?? true,
      };

      let productRecord = product.legacyProductId
        ? await tx.products.findFirst({
            where: { legacy_product_id: BigInt(product.legacyProductId) },
          })
        : null;

      if (productRecord) {
        logger.info(
          `[CREATE_PRODUCT] Producto legacy ${product.legacyProductId} ya existe (${productRecord.id}), actualizando.`,
        );
        productRecord = await tx.products.update({
          where: { id: productRecord.id },
          data: productData,
        });
      } else {
        productRecord = await tx.products.create({
          data: {
            legacy_product_id: product.legacyProductId
              ? BigInt(product.legacyProductId)
              : null,
            ...productData,
          },
        });
      }

      for (const sku of skus) {
        logger.info(
          `[CREATE_PRODUCT] Upsert SKU ${sku.skuCode} para producto ${productRecord.id}`,
        );
        await tx.skus.upsert({
          where: {
            product_id_sku_code: {
              product_id: productRecord.id,
              sku_code: sku.skuCode,
            },
          },
          create: {
            legacy_sku_id: sku.legacySkuId ? BigInt(sku.legacySkuId) : null,
            store_id: storeId,
            product_id: productRecord.id,
            sku_code: sku.skuCode,
            ean: sku.ean ?? null,
            regular_price: sku.regularPrice,
            sales_price: sku.salesPrice,
            purchase_price: sku.purchasePrice,
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
          },
          update: {
            ean: sku.ean ?? undefined,
            regular_price: sku.regularPrice,
            sales_price: sku.salesPrice,
            purchase_price: sku.purchasePrice,
            drop_price: sku.dropPrice ?? undefined,
            height_cm: sku.heightCm ?? undefined,
            width_cm: sku.widthCm ?? undefined,
            length_cm: sku.lengthCm ?? undefined,
            weight_kg: sku.weightKg ?? undefined,
            stock_min: sku.stockMin ?? undefined,
            stock_max: sku.stockMax ?? undefined,
            track_stock: sku.trackStock ?? undefined,
            allow_backorder: sku.allowBackorder ?? undefined,
            is_active: sku.isActive ?? undefined,
          },
        });
      }

      if (images && images.length > 0) {
        await tx.product_images.deleteMany({
          where: { product_id: productRecord.id },
        });

        await tx.product_images.createMany({
          data: images.map((img: ProductImagePayload, index: number) => ({
            id: randomUUID(),
            product_id: productRecord.id,
            url: img.url,
            title: img.title ?? null,
            alt_text: img.altText ?? null,
            position: img.position ?? index,
            is_primary: img.isPrimary ?? index === 0,
            image_type: img.imageType ?? "PRODUCT",
            width: img.width ?? null,
            height: img.height ?? null,
            file_size: img.fileSize ?? null,
            mime_type: img.mimeType ?? null,
            is_active: img.isActive ?? true,
          })),
        });
      }
    });

    logger.info(
      `[CREATE_PRODUCT] Producto procesado exitosamente: ${product.legacyProductId ?? product.name}`,
    );
  }

  private async resolveCategory(
    tx: any,
    storeId: string,
    category: ProductCategoryPayload,
  ): Promise<string | null> {
    if (category.id) {
      const existing = await tx.categories.findUnique({
        where: { id: category.id },
      });
      if (existing) return existing.id;
      logger.warn(
        `[CREATE_PRODUCT] category.id ${category.id} no existe, se resuelve por nombre.`,
      );
    }

    if (!category.name) {
      logger.warn("[CREATE_PRODUCT] category sin id ni name, se omite.");
      return null;
    }

    const normalizedName = category.name.trim();
    let existing = await tx.categories.findFirst({
      where: { store_id: storeId, name: normalizedName },
    });

    if (!existing) {
      logger.info(
        `[CREATE_PRODUCT] Creando categoría "${normalizedName}" para tienda ${storeId}`,
      );
      existing = await tx.categories.create({
        data: {
          store_id: storeId,
          parent_id: category.parentId ?? null,
          name: normalizedName,
          is_active: category.isActive ?? true,
        },
      });
    }

    return existing.id;
  }

  private async resolveCatalog(
    tx: any,
    storeId: string,
    catalogRef: ProductCatalogPayload,
  ): Promise<string | null> {
    if (catalogRef.id) {
      const existing = await tx.catalogs.findUnique({
        where: { id: catalogRef.id },
      });
      if (existing) return existing.id;
      logger.warn(
        `[CREATE_PRODUCT] catalog.id ${catalogRef.id} no existe, se resuelve por nombre.`,
      );
    }

    if (!catalogRef.name) {
      logger.warn("[CREATE_PRODUCT] catalog sin id ni name, se omite.");
      return null;
    }

    const normalizedName = catalogRef.name.trim();
    let existing = await tx.catalogs.findFirst({
      where: { store_id: storeId, name: normalizedName },
    });

    if (!existing) {
      logger.info(
        `[CREATE_PRODUCT] Creando catálogo "${normalizedName}" para tienda ${storeId}`,
      );
      existing = await tx.catalogs.create({
        data: {
          store_id: storeId,
          name: normalizedName,
          is_public: catalogRef.isPublic ?? false,
        },
      });
    }

    return existing.id;
  }
}
