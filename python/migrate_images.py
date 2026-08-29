import os
import csv
import hashlib
import logging
import requests
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv
import boto3
from botocore.exceptions import ClientError
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

# Configuración S3
S3_BUCKET = os.getenv('AWS_S3_BUCKET')
S3_REGION = os.getenv('AWS_REGION', 'us-east-1')

# Configuración BD Legacy
DB_CONFIG = {
    'host': os.getenv('DB_HOST_LEGACY'),
    'port': int(os.getenv('DB_PORT_LEGACY', 3306)),
    'user': os.getenv('DB_USER_LEGACY'),
    'password': os.getenv('DB_PASS_LEGACY'),
    'database': os.getenv('DB_NAME_LEGACY'),
    'charset': 'utf8mb4',
}

# Archivo de log de mapeo
MIGRATION_LOG_FILE = os.getenv('MIGRATION_LOG_FILE', 'migration_log.csv')
CSV_FIELDNAMES = ['product_id', 'status', 's3_key', 'new_url', 'message']


def init_s3():
    """Inicializa el cliente S3"""
    try:
        s3_client = boto3.client(
            's3',
            region_name=S3_REGION,
            aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
        )
        logger.info("✅ Conexión exitosa con S3")
        return s3_client
    except Exception as e:
        logger.error(f"❌ Error al conectar con S3: {e}")
        return None


def get_db_connection():
    """Conecta a la base de datos MySQL"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        logger.info("✅ Conexión exitosa a MySQL")
        return conn
    except MySQLError as e:
        logger.error(f"❌ Error al conectar con MySQL: {e}")
        return None


def generate_file_hash(product_id, url):
    """Genera un hash único basado en product_id + url"""
    unique_string = f"{product_id}_{url}"
    hash_object = hashlib.sha256(unique_string.encode())
    return hash_object.hexdigest()[:16]


def get_image_extension(url):
    """Obtiene la extensión de la imagen desde la URL"""
    if not url:
        return '.jpg'
    parsed = urlparse(url)
    ext = os.path.splitext(parsed.path)[1].lower()
    if ext in ['.jpg', '.jpeg', '.png', '.webp', '.gif']:
        return '.jpg' if ext == '.jpeg' else ext
    return '.jpg'


def download_image(url):
    """Descarga la imagen desde la URL"""
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.content
    except Exception as e:
        logger.error(f"❌ Error descargando {url}: {e}")
        return None


def upload_to_s3(s3_client, file_bytes, bucket, key, content_type='image/jpeg'):
    """Sube el archivo a S3"""
    try:
        s3_client.put_object(
            Bucket=bucket,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )
        return True
    except Exception as e:
        logger.error(f" Error subiendo {key} a S3: {e}")
        return False


def build_s3_key(product_id, created_at, url):
    """Construye la ruta S3: products/YYYY/MM/DD/hash.ext"""
    if isinstance(created_at, str):
        try:
            dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        except Exception:
            dt = datetime.now()
    elif isinstance(created_at, datetime):
        dt = created_at
    else:
        dt = datetime.now()

    year = dt.year
    month = dt.month
    day = dt.day

    file_hash = generate_file_hash(product_id, url)
    ext = get_image_extension(url)

    key = f"products/{year:04d}/{month:02d}/{day:02d}/{file_hash}{ext}"
    return key


def build_s3_url(bucket, region, key):
    """Construye la URL completa de S3"""
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"


def append_to_csv(row):
    """
    Agrega una fila al CSV inmediatamente.
    Si el archivo no existe o está vacío, escribe el header primero.
    """
    file_exists = os.path.isfile(MIGRATION_LOG_FILE)
    file_empty = file_exists and os.path.getsize(MIGRATION_LOG_FILE) == 0

    with open(MIGRATION_LOG_FILE, 'a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
        if not file_exists or file_empty:
            writer.writeheader()
        writer.writerow(row)
        f.flush()  # Forzar escritura en disco


def migrate_product(s3_client, product_id, url, created_at):
    """Migra un producto individual"""
    s3_key = build_s3_key(product_id, created_at, url)
    new_url = build_s3_url(S3_BUCKET, S3_REGION, s3_key)

    # Descargar imagen
    image_data = download_image(url)
    if not image_data:
        result = {
            'product_id': product_id,
            'status': 'failed',
            's3_key': s3_key,
            'new_url': '',
            'message': 'Error descargando imagen'
        }
        append_to_csv(result)
        return result

    # Detectar content-type
    ext = get_image_extension(url)
    content_types = {
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    }
    content_type = content_types.get(ext, 'image/jpeg')

    # Subir a S3
    success = upload_to_s3(s3_client, image_data, S3_BUCKET, s3_key, content_type)

    if success:
        result = {
            'product_id': product_id,
            'status': 'success',
            's3_key': s3_key,
            'new_url': new_url,
            'message': 'Migrado exitosamente'
        }
    else:
        result = {
            'product_id': product_id,
            'status': 'failed',
            's3_key': s3_key,
            'new_url': '',
            'message': 'Error subiendo a S3'
        }

    # ✅ Guardar inmediatamente en el CSV
    append_to_csv(result)
    return result


def main():
    """Función principal"""
    logger.info("🚀 Iniciando migración de imágenes a S3")
    logger.info("️  MODO: Solo BD legacy + escritura en S3. NO se actualiza la BD.")
    logger.info(f"📄 CSV se guardará en: {os.path.abspath(MIGRATION_LOG_FILE)}")

    # Inicializar S3
    s3_client = init_s3()
    if not s3_client:
        return

    # Conectar a BD
    conn = get_db_connection()
    if not conn:
        return

    cursor = conn.cursor()

    try:
        # Obtener productos
        cursor.execute("""
            SELECT id, urlImage, createdAt
            FROM Product
            WHERE urlImage IS NOT NULL
              AND urlImage != ''
              AND isActive = 1
            ORDER BY id
        """)
        products = cursor.fetchall()

        if not products:
            logger.info("ℹ️  No hay productos con imágenes para migrar")
            return

        logger.info(f" Total de productos a migrar: {len(products)}")

        success_count = 0
        failed_count = 0

        for i, product in enumerate(products, 1):
            product_id, url, created_at = product[0], product[1], product[2]

            logger.info(f"[{i}/{len(products)}] Procesando producto ID: {product_id}")

            result = migrate_product(s3_client, product_id, url, created_at)

            if result['status'] == 'success':
                success_count += 1
                logger.info(f"   ✅ Migrado: {result['new_url']}")
            else:
                failed_count += 1
                logger.error(f"   ❌ Fallido: {result['message']}")

            # Log de progreso cada 100 productos
            if i % 100 == 0:
                logger.info(f"📊 Progreso: {i}/{len(products)} | ✅ {success_count} | ❌ {failed_count}")

        # Resumen final
        logger.info("=" * 60)
        logger.info(" MIGRACIÓN COMPLETADA")
        logger.info(f"✅ Exitosos: {success_count}")
        logger.info(f"❌ Fallidos: {failed_count}")
        logger.info(f"📦 Total: {len(products)}")
        logger.info(f"📄 CSV guardado en: {os.path.abspath(MIGRATION_LOG_FILE)}")
        logger.info("=" * 60)

    finally:
        cursor.close()
        conn.close()
        logger.info("🔌 Conexión a MySQL cerrada")


if __name__ == "__main__":
    main()