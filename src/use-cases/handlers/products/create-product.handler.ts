// src/use-cases/handlers/products/create-product.handler.ts

import { PrismaClient, Prisma } from "@prisma/client";
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
    const { product, images, eventId } = payload;

    if (!product.name?.trim()) {
      throw new Error("[CREATE_PRODUCT] El nombre del producto es requerido.");
    }

    // ✅ CORREGIDO: statusId ahora es bigint | null (no string)
    let statusId: bigint | null = null;
    if (product.statusCode) {
      statusId = catalog.productStatuses[product.statusCode] ?? null;
      if (!statusId) {
        logger.warn(
          `[CREATE_PRODUCT] Status "${product.statusCode}" no encontrado. ` +
            `Disponibles: ${Object.keys(catalog.productStatuses).join(", ")}. ` +
            `Se migrará con status_id = null.`,
        );
      }
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // ✅ CORREGIDO: storeId es bigint | null
      const storeId = await this.resolveStore(
        tx,
        product.storeLegacyId,
        product.storeId,
      );

      // ✅ CORREGIDO: categoryId es bigint | null
      const categoryId = storeId
        ? await this.resolveCategory(tx, storeId, product.category)
        : null;

      // ✅ CORREGIDO: catalogId es bigint | null
      const catalogId = storeId
        ? await this.resolveCatalog(tx, storeId, product.catalog)
        : null;

      // ✅ CORREGIDO: productData con tipos correctos (bigint | null)
      const productData = {
        name: product.name.trim(),
        short_description: product.shortDescription ?? null,
        large_description: product.largeDescription ?? null,
        description: product.description ?? null,
        url_image: product.urlImage ?? null,
        url_reference: product.urlReference ?? null,
        is_product_global: product.isProductGlobal ?? false,
        sale_price_drop: product.salePriceDrop ?? null,
        price_drop_crate: product.priceDropCrate ?? null,
        price_drop_dozen: product.priceDropDozen ?? null,
        retail_price_suggested: product.retailPriceSuggested ?? null,
        units_crate: product.unitsCrate ?? null,
        is_novelty: product.isNovelty ?? false,
        is_large_volume: product.isLargeVolume ?? false,
        is_validate: product.isValidate ?? false,
        is_registered_product: product.isRegisteredProduct ?? false,
        is_active: product.isActive ?? true,
        store_id: storeId, // ✅ bigint | null
        category_id: categoryId, // ✅ bigint | null
        catalog_id: catalogId, // ✅ bigint | null
        ...(statusId ? { status_id: statusId } : {}), // ✅ bigint | null
      };

      // ✅ CORREGIDO: Buscar producto existente por legacy_product_id
      let productRecord = product.legacyProductId
        ? await tx.product.findFirst({
            where: {
              legacy_product_id: product.legacyProductId,
            },
            select: { id: true },
          })
        : null;

      if (productRecord) {
        logger.info(
          `[CREATE_PRODUCT] Producto legacy ${product.legacyProductId} ya existe (${productRecord.id}), actualizando.`,
        );
        productRecord = await tx.product.update({
          where: { id: productRecord.id },
          data: productData,
        });
      } else {
        // ✅ CORREGIDO: Crear producto sin id (autoincrement)
        productRecord = await tx.product.create({
          data: {
            legacy_product_id: product.legacyProductId ?? null,
            ...productData,
          },
        });
        logger.info(
          `[CREATE_PRODUCT] Producto creado: ${productRecord.id} (legacy: ${product.legacyProductId})`,
        );
      }

      // ✅ CORREGIDO: Migrar imágenes
      if (images && images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((img, index) => ({
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
          skipDuplicates: true,
        });
        logger.info(
          `[CREATE_PRODUCT] ${images.length} imágenes migradas para producto ${productRecord.id}`,
        );
      }
    });

    logger.info(
      `[CreateProductHandler] Producto migrado exitosamente: ${eventId}`,
    );
  }

  // ✅ CORREGIDO: Retorna bigint | null
  private async resolveStore(
    tx: Prisma.TransactionClient,
    storeLegacyId?: number,
    storeId?: bigint | null, // ✅ CORREGIDO: string → bigint | null
  ): Promise<bigint | null> {
    // Si viene storeId (ya es bigint)
    if (storeId) {
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { id: true },
      });
      if (store) {
        return store.id;
      }
      logger.warn(`[CREATE_PRODUCT] Store no encontrado con id: ${storeId}`);
    }

    if (storeLegacyId) {
      const store = await tx.store.findFirst({
        where: { legacy_store_id: storeLegacyId },
        select: { id: true },
      });
      if (store) {
        return store.id;
      }
      logger.warn(
        `[CREATE_PRODUCT] Store no encontrado con legacy_store_id: ${storeLegacyId}`,
      );
    }

    logger.info(
      "[CREATE_PRODUCT] Producto sin store asociado (producto global o sin tienda).",
    );
    return null;
  }

  // ✅ CORREGIDO: storeId es bigint | null, retorna bigint | null
  private async resolveCategory(
    tx: Prisma.TransactionClient,
    storeId: bigint | null,
    category?: ProductCategoryPayload | null,
  ): Promise<bigint | null> {
    if (!storeId || !category) return null;

    if (!category.name) {
      logger.warn("[CREATE_PRODUCT] category sin id ni name, se omite.");
      return null;
    }

    const normalizedName = category.name.trim();

    // ✅ CORREGIDO: where con store_id = bigint
    let existing = await tx.category.findFirst({
      where: {
        store_id: storeId,
        name: normalizedName,
        is_active: true,
      },
      select: { id: true },
    });

    if (!existing) {
      logger.info(
        `[CREATE_PRODUCT] Creando categoría "${normalizedName}" para tienda ${storeId}`,
      );

      // ✅ CORREGIDO: parentId como bigint | null
      const parentId = category.parentId ?? null;

      existing = await tx.category.create({
        data: {
          store_id: storeId,
          parent_id: parentId,
          name: normalizedName,
          is_active: category.isActive ?? true,
        },
        select: { id: true },
      });
    }

    return existing.id;
  }

  // ✅ CORREGIDO: storeId es bigint | null, retorna bigint | null
  private async resolveCatalog(
    tx: Prisma.TransactionClient,
    storeId: bigint | null,
    catalogRef?: ProductCatalogPayload | null,
  ): Promise<bigint | null> {
    if (!storeId || !catalogRef) return null;

    if (!catalogRef.name) {
      logger.warn("[CREATE_PRODUCT] catalog sin id ni name, se omite.");
      return null;
    }

    const normalizedName = catalogRef.name.trim();

    // ✅ CORREGIDO: where con store_id = bigint
    let existing = await tx.catalog.findFirst({
      where: {
        store_id: storeId,
        name: normalizedName,
        is_public: catalogRef.isPublic ?? false,
      },
      select: { id: true },
    });

    if (!existing) {
      logger.info(
        `[CREATE_PRODUCT] Creando catálogo "${normalizedName}" para tienda ${storeId}`,
      );
      existing = await tx.catalog.create({
        data: {
          store_id: storeId,
          name: normalizedName,
          is_public: catalogRef.isPublic ?? false,
        },
        select: { id: true },
      });
    }

    return existing.id;
  }
}
