"""
migrate_ubigeos_peru.py
Migración de tabla Ubigeo (legacy) → ubigeos (Aurora)
Solo ubigeos de Perú (countryCode = 'PER')
Con logging mejorado y feedback de progreso
"""

import os
import logging
import time
from datetime import datetime
from dotenv import load_dotenv
import mysql.connector
from mysql.connector import Error as MySQLError

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(f"ubigeo_migration_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log", encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CONFIGURACIÓN LEGACY (aliclik)
# ─────────────────────────────────────────────
DB_LEGACY = {
    "host": os.getenv("DB_HOST_LEGACY"),
    "port": int(os.getenv("DB_PORT_LEGACY", 3306)),
    "user": os.getenv("DB_USER_LEGACY"),
    "password": os.getenv("DB_PASS_LEGACY"),
    "database": os.getenv("DB_NAME_LEGACY", "aliclikapp"),
    "charset": "utf8mb4",
    "use_unicode": True,
}

# ─────────────────────────────────────────────
# CONFIGURACIÓN AURORA (aliclikapp)
# ─────────────────────────────────────────────
DB_AURORA = {
    "host": os.getenv("DB_HOST_AURORA"),
    "port": int(os.getenv("DB_PORT_AURORA", 3306)),
    "user": os.getenv("DB_USER_AURORA"),
    "password": os.getenv("DB_PASS_AURORA"),
    "database": os.getenv("DB_NAME_AURORA", "aliclik"),
    "charset": "utf8mb4",
    "use_unicode": True,
}

BATCH_SIZE = int(os.getenv("BATCH_SIZE", 500))


def get_legacy_connection():
    try:
        conn = mysql.connector.connect(**DB_LEGACY)
        logger.info("✅ Conexión exitosa a BD LEGACY")
        return conn
    except MySQLError as e:
        logger.error(f"❌ Error conectando a BD legacy: {e}")
        return None


def get_aurora_connection():
    try:
        conn = mysql.connector.connect(**DB_AURORA)
        logger.info("✅ Conexión exitosa a BD AURORA")
        return conn
    except MySQLError as e:
        logger.error(f"❌ Error conectando a BD Aurora: {e}")
        return None


def get_peru_country_id(cursor_aurora) -> int:
    """Obtiene el ID de Perú desde la tabla countries en Aurora."""
    cursor_aurora.execute("""
        SELECT id FROM countries 
        WHERE iso_code = 'PER' AND is_active = 1
    """)
    row = cursor_aurora.fetchone()
    
    if not row:
        raise ValueError("❌ No se encontró Perú en la tabla countries (iso_code='PER')")
    
    peru_id = row[0]
    logger.info(f"🇵🇪 Perú encontrado en Aurora: id={peru_id}")
    return peru_id


def get_levels_mapping(cursor_aurora, country_id: int) -> dict[int, int]:
    """Retorna {nivel_legacy: level_id} desde ubigeos_levels en Aurora."""
    cursor_aurora.execute("""
        SELECT id, level, name 
        FROM ubigeos_levels 
        WHERE country_id = %s AND is_active = 1
        ORDER BY level
    """, (country_id,))
    
    rows = cursor_aurora.fetchall()
    mapping = {level: lid for lid, level, _ in rows}
    
    logger.info(f"📊 Niveles de Perú en Aurora: {mapping}")
    
    if not mapping:
        raise ValueError(f"❌ No se encontraron niveles para country_id={country_id}")
    
    return mapping


def migrate_ubigeos_peru():
    start_time = time.time()
    
    conn_legacy = get_legacy_connection()
    conn_aurora = get_aurora_connection()
    
    if not conn_legacy or not conn_aurora:
        logger.error("❌ No se pudo establecer conexión a ambas bases de datos")
        return

    cursor_legacy = conn_legacy.cursor()
    cursor_aurora = conn_aurora.cursor()

    try:
        # 1. Obtener ID de Perú desde Aurora
        logger.info("🔍 Obteniendo ID de Perú...")
        peru_country_id = get_peru_country_id(cursor_aurora)
        
        # 2. Obtener mapeo de niveles para Perú
        logger.info("🔍 Obteniendo mapeo de niveles...")
        level_map = get_levels_mapping(cursor_aurora, peru_country_id)
        
        # 3. Verificar niveles en legacy (solo Perú)
        logger.info("🔍 Verificando niveles en legacy...")
        cursor_legacy.execute("""
            SELECT DISTINCT nivel, COUNT(*) as total 
            FROM Ubigeo 
            WHERE countryCode = 'PER'
            GROUP BY nivel 
            ORDER BY nivel
        """)
        legacy_niveles = cursor_legacy.fetchall()
        logger.info(f" Niveles en legacy (Perú): {legacy_niveles}")
        
        # 4. Contar registros legacy de Perú
        logger.info(" Contando registros a migrar...")
        cursor_legacy.execute("""
            SELECT COUNT(*) FROM Ubigeo 
            WHERE countryCode = 'PER'
        """)
        total = cursor_legacy.fetchone()[0]
        logger.info(f"📦 Total de ubigeos legacy de Perú a migrar: {total}")
        
        if total == 0:
            logger.warning("⚠️ No hay ubigeos de Perú en la tabla legacy")
            return

        # 5. Leer ubigeos legacy de Perú ordenados por nivel
        logger.info(" Cargando registros desde legacy...")
        cursor_legacy.execute("""
            SELECT id, name, nivel, parentId, countryCode, postalCode, isActive
            FROM Ubigeo
            WHERE countryCode = 'PER'
            ORDER BY COALESCE(nivel, 99), id
        """)
        legacy_rows = cursor_legacy.fetchall()
        logger.info(f"✅ {len(legacy_rows)} registros cargados en memoria")

        # 6. PRUEBA: Insertar el primer registro para validar
        logger.info("🧪 PROBANDO PRIMER INSERT...")
        if legacy_rows:
            test_row = legacy_rows[0]
            (
                test_legacy_id, test_name, test_nivel, test_parent_id_legacy,
                test_country_code, test_postal_code, test_is_active
            ) = test_row
            
            test_level_id = level_map.get(test_nivel)
            
            if test_level_id:
                logger.info(f"   Legacy ID: {test_legacy_id}")
                logger.info(f"   Name: {test_name}")
                logger.info(f"   Nivel: {test_nivel} → level_id: {test_level_id}")
                logger.info(f"   Parent ID (legacy): {test_parent_id_legacy}")
                logger.info(f"   Country Code: {test_country_code}")
                
                try:
                    cursor_aurora.execute("""
                        INSERT INTO ubigeos (
                            legacy_ubigeo_id, country_id, parent_id, level_id,
                            name, inei_code, postal_code, is_active
                        ) VALUES (%s, %s, %s, %s, %s, NULL, %s, %s)
                    """, (
                        test_legacy_id,
                        peru_country_id,
                        None,  # Primer registro sin padre
                        test_level_id,
                        test_name.strip()[:200],
                        test_postal_code[:20] if test_postal_code else None,
                        1 if test_is_active else 0,
                    ))
                    conn_aurora.commit()
                    test_new_id = cursor_aurora.lastrowid
                    logger.info(f"✅ PRIMER INSERT EXITOSO! New ID: {test_new_id}")
                    
                    # Eliminar el registro de prueba para comenzar limpio
                    cursor_aurora.execute("DELETE FROM ubigeos WHERE id = %s", (test_new_id,))
                    conn_aurora.commit()
                    logger.info("🗑️ Registro de prueba eliminado")
                    
                except MySQLError as e:
                    logger.error(f"❌ ERROR en primer INSERT: {e}")
                    conn_aurora.rollback()
                    raise
            else:
                logger.warning(f"⚠️ Nivel {test_nivel} no existe en Aurora, saltando prueba")

        # 7. Diccionario para mapear legacy_id → new_id
        id_mapping: dict[int, int] = {}

        # 8. Stats
        success = 0
        skipped = 0
        failed = 0
        failed_details = []
        skipped_niveles = {}
        
        processing_start = time.time()

        # 9. Procesar en batch con logging mejorado
        logger.info("=" * 60)
        logger.info("🚀 INICIANDO MIGRACIÓN...")
        logger.info("=" * 60)

        for i, row in enumerate(legacy_rows, 1):
            (
                legacy_id, name, nivel, parent_id_legacy,
                country_code, postal_code, is_active
            ) = row

            try:
                if not name or not name.strip():
                    skipped += 1
                    continue

                # Resolver level_id
                level_id = level_map.get(nivel)
                
                if not level_id:
                    skipped_niveles[nivel] = skipped_niveles.get(nivel, 0) + 1
                    skipped += 1
                    continue

                # Resolver parent_id
                new_parent_id = None
                if parent_id_legacy is not None:
                    new_parent_id = id_mapping.get(parent_id_legacy)
                    if new_parent_id is None:
                        failed += 1
                        failed_details.append(
                            f"legacy_id={legacy_id}: parent legacy {parent_id_legacy} "
                            f"no está en el mapping"
                        )
                        continue

                # INSERT en AURORA
                cursor_aurora.execute("""
                    INSERT INTO ubigeos (
                        legacy_ubigeo_id, country_id, parent_id, level_id,
                        name, inei_code, postal_code, is_active
                    ) VALUES (%s, %s, %s, %s, %s, NULL, %s, %s)
                """, (
                    legacy_id,
                    peru_country_id,
                    new_parent_id,
                    level_id,
                    name.strip()[:200],
                    postal_code[:20] if postal_code else None,
                    1 if is_active else 0,
                ))
                new_id = cursor_aurora.lastrowid
                id_mapping[legacy_id] = new_id
                success += 1

                # Logging cada 100 registros
                if i % 100 == 0:
                    elapsed = time.time() - processing_start
                    rate = 100 / elapsed if elapsed > 0 else 0
                    eta_seconds = (total - i) / rate if rate > 0 else 0
                    eta_minutes = eta_seconds / 60
                    
                    logger.info(
                        f"📊 Progreso: {i}/{total} ({i/total*100:.1f}%) | "
                        f"✅ {success} | ⏭️ {skipped} | ❌ {failed} | "
                        f"Velocidad: {rate:.1f} reg/seg | "
                        f"ETA: {eta_minutes:.1f} min"
                    )

                # Commit cada BATCH_SIZE
                if i % BATCH_SIZE == 0:
                    conn_aurora.commit()
                    elapsed_total = time.time() - start_time
                    logger.info(
                        f"💾 Batch {i}/{total} committed en Aurora | "
                        f"Tiempo total: {elapsed_total:.1f} seg"
                    )

            except MySQLError as e:
                failed += 1
                failed_details.append(f"legacy_id={legacy_id}: {e}")
                conn_aurora.rollback()
                logger.error(f" Error en registro {i}: {e}")

        # Commit final
        conn_aurora.commit()
        total_time = time.time() - start_time

        # Reporte final
        logger.info("=" * 60)
        logger.info("✅ MIGRACIÓN DE UBIGEOS PERÚ COMPLETADA")
        logger.info(f"   ✅ Exitosos:  {success}")
        logger.info(f"   ⏭️  Omitidos:  {skipped}")
        logger.info(f"   ❌ Fallidos:  {failed}")
        logger.info(f"   ⏱️  Tiempo total: {total_time:.1f} segundos ({total_time/60:.1f} min)")
        
        if success > 0:
            avg_time = total_time / success
            logger.info(f"   📈 Promedio: {avg_time:.3f} seg/registro")
        
        if skipped_niveles:
            logger.info(f"   📊 Niveles omitidos (no existen en Aurora):")
            for nivel, count in skipped_niveles.items():
                logger.info(f"      • nivel={nivel}: {count} registros")
        
        logger.info("=" * 60)

        if failed_details:
            logger.warning(f"📋 Primeros 20 errores:")
            for detail in failed_details[:20]:
                logger.warning(f"   • {detail}")

            error_file = "ubigeos_peru_migration_errors.log"
            with open(error_file, "w", encoding="utf-8") as f:
                f.write("\n".join(failed_details))
            logger.info(f"📄 Errores completos en: {error_file}")

    except MySQLError as e:
        logger.error(f"❌ Error durante la migración: {e}")
        conn_aurora.rollback()
    except ValueError as e:
        logger.error(str(e))
    finally:
        cursor_legacy.close()
        cursor_aurora.close()
        conn_legacy.close()
        conn_aurora.close()
        logger.info("🔌 Conexiones cerradas")


if __name__ == "__main__":
    migrate_ubigeos_peru()