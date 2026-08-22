import { getAuroraDb } from '../services/aurora.service';

export interface CatalogCache {
  docTypes: Record<string, string>;        // { 'DNI': 'uuid-123', 'RUC': 'uuid-456' }
  ubigeos: Record<string, string>;         // { '150101': 'uuid-789' }
  stores: Record<string, string>;          // { '65921': 'uuid-abc' }
  roles: Record<string, string>;           // { 'ADMIN_STORE': 'uuid-def' }
  countries: Record<string, string>;       // { 'PER': 'uuid-ghi' }
  productStatuses: Record<string, string>; // { 'ACTIVE': 'uuid-jkl' }
}

let CATALOG_CACHE: CatalogCache | null = null;

/**
 * Carga y cachea los catálogos desde Aurora.
 * Se ejecuta una sola vez (singleton) para no saturar la BD.
 */
export async function getCatalogCache(): Promise<CatalogCache> {
  if (CATALOG_CACHE) {
    return CATALOG_CACHE;
  }

  console.log('📚 Cargando catálogos desde Aurora...');

  const db = getAuroraDb();

  try {
    // Ejecutamos todas las consultas en paralelo
    const [docTypes, ubigeos, stores, roles, countries, productStatuses] = await Promise.all([
      // 1. Tipos de documento
      db.$queryRaw<Array<{ id: string; code: string }>>`
        SELECT id, code FROM document_types
      `,

      // 2. Ubigeos (departamentos/provincias/distritos)
      db.$queryRaw<Array<{ id: string; code: string }>>`
        SELECT id, code FROM ubigeos
      `,

      // 3. Tiendas (mapeo legacy_id → nuevo_id)
      db.$queryRaw<Array<{ id: string; legacy_store_id: string }>>`
        SELECT id, legacy_store_id FROM stores
        WHERE legacy_store_id IS NOT NULL
      `,

      // 4. Roles
      db.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT id, name FROM roles
      `,

      db.$queryRaw<Array<{ id: string; iso_code: string }>>`
        SELECT id, iso_code FROM countries
      `,

      // 5. Estados de producto (ej: 'ACTIVE', 'DRAFT', 'ARCHIVED')
      db.$queryRaw<Array<{ id: string; code: string }>>`
        SELECT id, code FROM product_statuses
      `,
    ]);

    // Convertimos arrays a objetos de búsqueda rápida
    CATALOG_CACHE = {
      // { 'DNI': 'uuid-123', 'RUC': 'uuid-456' }
      docTypes: Object.fromEntries(
        docTypes.map((d) => [d.code, d.id])
      ),

      // { '150101': 'uuid-789' }
      ubigeos: Object.fromEntries(
        ubigeos.map((u) => [u.code, u.id])
      ),

      // { '65921': 'uuid-abc' }
      stores: Object.fromEntries(
        stores.map((s) => [String(s.legacy_store_id), s.id])
      ),

      // { 'ADMIN_STORE': 'uuid-def' }
      roles: Object.fromEntries(
        roles.map((r) => [r.name, r.id])
      ),

      // { 'PER': 'uuid-ghi' }
      countries: Object.fromEntries(
        countries.map((c) => [c.iso_code, c.id])
      ),

      // { 'ACTIVE': 'uuid-jkl' }
      productStatuses: Object.fromEntries(
        productStatuses.map((p) => [p.code, p.id])
      ),
    };

    console.log('✅ Catálogos cargados:', {
      docTypes: Object.keys(CATALOG_CACHE.docTypes).length,
      ubigeos: Object.keys(CATALOG_CACHE.ubigeos).length,
      stores: Object.keys(CATALOG_CACHE.stores).length,
      roles: Object.keys(CATALOG_CACHE.roles).length,
      countries: Object.keys(CATALOG_CACHE.countries).length,
      productStatuses: Object.keys(CATALOG_CACHE.productStatuses).length,
    });

    return CATALOG_CACHE;
  } catch (error) {
    console.error('❌ Error cargando catálogos:', error);
    throw new Error(
      'No se pudo inicializar los catálogos. Verifica la conexión a Aurora'
    );
  }
}

/**
 * Limpia el cache (útil para tests o recargar datos)
 */
export function clearCatalogCache(): void {
  CATALOG_CACHE = null;
}