// src/utils/catalog.ts

import { getAuroraDb } from "../services/aurora.service";

// ✅ CORREGIDO: Todos los IDs ahora son bigint
export interface CatalogCache {
  docTypes: Record<string, bigint>;
  ubigeos: Record<string, bigint>;
  stores: Record<string, bigint>;
  roles: Record<string, bigint>;
  countries: Record<string, bigint>;
  productStatuses: Record<string, bigint>;
}

let CATALOG_CACHE: CatalogCache | null = null;

export async function getCatalogCache(): Promise<CatalogCache> {
  if (CATALOG_CACHE) {
    return CATALOG_CACHE;
  }

  console.log("📚 Cargando catálogos desde Aurora...");
  const db = getAuroraDb();

  try {
    // ✅ CORREGIDO: Los IDs vienen como bigint directamente
    const [docTypes, ubigeos, stores, roles, countries, productStatuses] =
      await Promise.all([
        db.$queryRaw<Array<{ id: bigint; code: string }>>`
        SELECT id, code FROM document_types
      `,
        db.$queryRaw<Array<{ id: bigint; code: string }>>`
        SELECT id, code FROM ubigeos
      `,
        db.$queryRaw<Array<{ id: bigint; legacy_store_id: bigint | null }>>`
        SELECT id, legacy_store_id FROM stores WHERE legacy_store_id IS NOT NULL
      `,
        db.$queryRaw<Array<{ id: bigint; name: string }>>`
        SELECT id, name FROM roles
      `,
        db.$queryRaw<Array<{ id: bigint; iso_code: string }>>`
        SELECT id, iso_code FROM countries
      `,
        db.$queryRaw<Array<{ id: bigint; code: string }>>`
        SELECT id, code FROM product_statuses
      `,
      ]);

    // ✅ CORREGIDO: Los valores son bigint
    CATALOG_CACHE = {
      docTypes: Object.fromEntries(
        docTypes.map((d) => [d.code, d.id]), // d.id es bigint
      ),
      ubigeos: Object.fromEntries(
        ubigeos.map((u) => [u.code, u.id]), // u.id es bigint
      ),
      stores: Object.fromEntries(
        stores.map((s) => [String(s.legacy_store_id), s.id]), // s.id es bigint
      ),
      roles: Object.fromEntries(
        roles.map((r) => [r.name, r.id]), // r.id es bigint
      ),
      countries: Object.fromEntries(
        countries.map((c) => [c.iso_code, c.id]), // c.id es bigint
      ),
      productStatuses: Object.fromEntries(
        productStatuses.map((p) => [p.code, p.id]), // p.id es bigint
      ),
    };

    console.log("✅ Catálogos cargados:", {
      docTypes: Object.keys(CATALOG_CACHE.docTypes).length,
      ubigeos: Object.keys(CATALOG_CACHE.ubigeos).length,
      stores: Object.keys(CATALOG_CACHE.stores).length,
      roles: Object.keys(CATALOG_CACHE.roles).length,
      countries: Object.keys(CATALOG_CACHE.countries).length,
      productStatuses: Object.keys(CATALOG_CACHE.productStatuses).length,
    });

    return CATALOG_CACHE;
  } catch (error) {
    console.error("❌ Error cargando catálogos:", error);
    throw new Error(
      "No se pudo inicializar los catálogos. Verifica la conexión a Aurora",
    );
  }
}

export function clearCatalogCache(): void {
  CATALOG_CACHE = null;
}
