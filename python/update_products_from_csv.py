import os
import csv
import logging
import argparse
from dotenv import load_dotenv
import mysql.connector
from mysql.connector import Error as MySQLError

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Cargar variables de entorno
load_dotenv()

# Configuración BD Legacy
DB_CONFIG = {
    'host': os.getenv('DB_HOST_LEGACY'),
    'port': int(os.getenv('DB_PORT_LEGACY', 3306)),
    'user': os.getenv('DB_USER_LEGACY'),
    'password': os.getenv('DB_PASS_LEGACY'),
    'database': os.getenv('DB_NAME_LEGACY'),
    'charset': 'utf8mb4',
}

# Archivo CSV de entrada (generado por la migración)
MIGRATION_LOG_FILE = os.getenv('MIGRATION_LOG_FILE', 'migration_log.csv')

# Tamaño de batch para los UPDATEs
BATCH_SIZE = int(os.getenv('BATCH_SIZE', 500))


def get_db_connection():
    """Conecta a la base de datos MySQL"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        logger.info("✅ Conexión exitosa a MySQL (modo ESCRITURA)")
        return conn
    except MySQLError as e:
        logger.error(f"❌ Error al conectar con MySQL: {e}")
        return None


def load_migration_csv(csv_path: str):
    """Carga el CSV de migración y retorna solo los registros exitosos"""
    if not os.path.exists(csv_path):
        logger.error(f"❌ No se encontró el archivo CSV: {csv_path}")
        return []
    
    successful = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['status'].strip().lower() == 'success':
                successful.append({
                    'product_id': int(row['product_id']),
                    'new_url': row['new_url'].strip(),
                    's3_key': row['s3_key'].strip(),
                })
    
    logger.info(f" CSV cargado: {len(successful)} registros exitosos de {sum(1 for _ in open(csv_path, encoding='utf-8')) - 1} totales")
    return successful


def dry_run(records: list):
    """Muestra qué se va a actualizar sin tocar la BD"""
    logger.info("=" * 60)
    logger.info(" DRY RUN - Simulación de actualización")
    logger.info("=" * 60)
    
    for i, rec in enumerate(records[:20], 1):  # Mostrar solo primeros 20
        logger.info(f"[{i}] Product ID {rec['product_id']} → {rec['new_url']}")
    
    if len(records) > 20:
        logger.info(f"... y {len(records) - 20} más")
    
    logger.info("=" * 60)
    logger.info(f"Total a actualizar: {len(records)} registros")
    logger.info("=" * 60)


def update_products_in_batches(records: list, batch_size: int = BATCH_SIZE):
    """Actualiza los productos en batches"""
    conn = get_db_connection()
    if not conn:
        return 0
    
    cursor = conn.cursor()
    total_updated = 0
    total_batches = (len(records) + batch_size - 1) // batch_size
    
    try:
        for batch_num in range(total_batches):
            start = batch_num * batch_size
            end = start + batch_size
            batch = records[start:end]
            
            # Construir UPDATE con CASE WHEN para múltiples IDs
            # Esto es más eficiente que hacer N UPDATEs individuales
            case_when = "CASE id "
            values = []
            ids = []
            
            for rec in batch:
                case_when += "WHEN %s THEN %s "
                values.extend([rec['product_id'], rec['new_url']])
                ids.append(rec['product_id'])
            
            case_when += "END"
            
            query = f"""
                UPDATE Product
                SET urlImage = {case_when}
                WHERE id IN ({','.join(['%s'] * len(ids))})
            """
            values.extend(ids)
            
            cursor.execute(query, values)
            affected = cursor.rowcount
            conn.commit()
            
            total_updated += affected
            logger.info(f"📦 Batch {batch_num + 1}/{total_batches}: {affected} registros actualizados")
        
        logger.info(f"✅ Total actualizado: {total_updated} registros")
        
    except MySQLError as e:
        logger.error(f"❌ Error en la actualización: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()
    
    return total_updated


def main():
    parser = argparse.ArgumentParser(description='Actualizar Product.urlImage desde CSV de migración')
    parser.add_argument('--dry-run', action='store_true', help='Simular sin actualizar')
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE, help='Tamaño de batch')
    parser.add_argument('--csv', default=MIGRATION_LOG_FILE, help='Ruta al CSV de migración')
    parser.add_argument('--yes', action='store_true', help='Saltar confirmación (solo con --dry-run)')
    
    args = parser.parse_args()
    
    # Cargar registros exitosos del CSV
    records = load_migration_csv(args.csv)
    if not records:
        logger.warning("⚠️ No hay registros exitosos para actualizar")
        return
    
    # Modo dry-run
    if args.dry_run:
        dry_run(records)
        return
    
    # Confirmación antes de ejecutar
    if not args.yes:
        print(f"\n⚠️  Se van a actualizar {len(records)} registros en la tabla Product")
        print("   Campo: urlImage")
        print("   Fuente: " + args.csv)
        confirm = input("\n¿Continuar? (escribe 'SI' para confirmar): ").strip()
        if confirm != 'SI':
            logger.info("❌ Operación cancelada")
            return
    
    # Ejecutar actualización
    updated = update_products_in_batches(records, args.batch_size)
    
    if updated > 0:
        logger.info(f"🎉 Actualización completada: {updated} registros")
    else:
        logger.warning("⚠️ No se actualizó ningún registro")


if __name__ == "__main__":
    main()