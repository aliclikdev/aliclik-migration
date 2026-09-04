import os
import csv
import hashlib
import logging
import signal
import sys
import time
import io
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv
import boto3
from botocore.exceptions import ClientError
import mysql.connector
from mysql.connector import Error as MySQLError
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from PIL import Image

# ============================================================
# CONFIGURACIÓN DE LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('evidence_migration.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ============================================================
# VARIABLES GLOBALES PARA GRACEFUL SHUTDOWN
# ============================================================
running = True

def signal_handler(sig, frame):
    global running
    logger.info('⚠️  Señal de interrupción recibida. Finalizando gracefully...')
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ============================================================
# CARGA DE VARIABLES DE ENTORNO
# ============================================================
load_dotenv()

# Configuración S3
S3_BUCKET = os.getenv('EVIDENCE_S3_BUCKET', 'evidence-aliclik')
S3_REGION = os.getenv('AWS_REGION', 'us-east-1')
S3_PREFIX = os.getenv('S3_PREFIX', 'liquidation/motorized')

# Configuración de optimización de imágenes
IMAGE_CONFIG = {
    'max_width': int(os.getenv('IMAGE_MAX_WIDTH', 1920)),
    'max_height': int(os.getenv('IMAGE_MAX_HEIGHT', 1920)),
    'quality': int(os.getenv('IMAGE_QUALITY', 80)),
    'convert_to_webp': True,
}

# Configuración BD Legacy
DB_CONFIG = {
    'host': os.getenv('DB_HOST_LEGACY'),
    'port': int(os.getenv('DB_PORT_LEGACY', 3306)),
    'user': os.getenv('DB_USER_LEGACY'),
    'password': os.getenv('DB_PASS_LEGACY'),
    'database': os.getenv('DB_NAME_LEGACY'),
    'charset': 'utf8mb4',
}

# Configuración de migración
MIGRATION_LOG_FILE = os.getenv('EVIDENCE_MIGRATION_LOG', 'evidence_migration_log.csv')
BATCH_SIZE = int(os.getenv('BATCH_SIZE', 200))  # Reducido a 200 para evitar timeouts
MAX_RETRIES = int(os.getenv('MAX_RETRIES', 3))
REQUEST_TIMEOUT = int(os.getenv('REQUEST_TIMEOUT', 30))
RATE_LIMIT_DELAY = float(os.getenv('RATE_LIMIT_DELAY', 0.05))

CSV_FIELDNAMES = ['evidence_id', 'status', 's3_key', 'new_url', 'original_size', 'optimized_size', 'message']


def create_http_session():
    """Crea una sesión HTTP con reintentos automáticos"""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=0.3,
        status_forcelist=(500, 502, 504)
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session


def init_s3():
    """Inicializa el cliente S3"""
    try:
        s3_client = boto3.client(
            's3',
            region_name=S3_REGION,
            aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
        )
        s3_client.head_bucket(Bucket=S3_BUCKET)
        logger.info(f"✅ Conexión exitosa con S3 (bucket: {S3_BUCKET})")
        return s3_client
    except ClientError as e:
        logger.error(f"❌ Error al conectar con S3: {e}")
        return None
    except Exception as e:
        logger.error(f" Error inesperado con S3: {e}")
        return None


def get_db_connection():
    """Conecta a la base de datos MySQL"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        logger.info("✅ Conexión exitosa a MySQL (modo SOLO LECTURA)")
        return conn
    except MySQLError as e:
        logger.error(f"❌ Error al conectar con MySQL: {e}")
        return None


def get_all_frames(img):
    """Extrae todos los frames de un GIF animado"""
    frames = []
    try:
        while True:
            frames.append(img.copy())
            img.seek(len(frames))
    except EOFError:
        pass
    return frames


def optimize_image(image_bytes, original_format='JPEG'):
    """
    Optimiza una imagen:
    - GIFs animados → WebP animado
    - TODO lo demás (JPEG, PNG, GIF estático) → WebP estático
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        original_size = len(image_bytes)
        
        # Detectar si es GIF animado
        is_animated_gif = False
        if original_format.upper() == 'GIF':
            try:
                img.seek(1)
                img.seek(0)
                is_animated_gif = True
                logger.debug(" GIF animado detectado")
            except EOFError:
                is_animated_gif = False
                logger.debug("📷 GIF estático detectado")
        
        # 1. GIF ANIMADO → WebP animado
        if is_animated_gif:
            frames = get_all_frames(img)
            
            output_buffer = io.BytesIO()
            img.save(
                output_buffer,
                format='WEBP',
                save_all=True,
                append_images=frames[1:] if len(frames) > 1 else [],
                loop=0,
                quality=IMAGE_CONFIG['quality'],
                method=6
            )
            optimized_bytes = output_buffer.getvalue()
            optimized_size = len(optimized_bytes)
            reduction = ((original_size - optimized_size) / original_size) * 100
            
            logger.info(f"✅ GIF animado → WebP animado: {original_size/1024:.1f}KB → {optimized_size/1024:.1f}KB ({reduction:.1f}% menos)")
            return optimized_bytes, original_size, optimized_size, '.webp'
        
        # 2. TODO LO DEMÁS → WebP estático
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Redimensionar si excede dimensiones máximas
        width, height = img.size
        if width > IMAGE_CONFIG['max_width'] or height > IMAGE_CONFIG['max_height']:
            ratio = min(
                IMAGE_CONFIG['max_width'] / width,
                IMAGE_CONFIG['max_height'] / height
            )
            new_size = (int(width * ratio), int(height * ratio))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
            logger.debug(f" Redimensionado a: {new_size}")
        
        # Guardar como WebP estático
        output_buffer = io.BytesIO()
        img.save(
            output_buffer,
            format='WEBP',
            quality=IMAGE_CONFIG['quality'],
            method=6
        )
        optimized_bytes = output_buffer.getvalue()
        optimized_size = len(optimized_bytes)
        reduction = ((original_size - optimized_size) / original_size) * 100
        
        logger.info(f"✅ {original_format} → WebP estático: {original_size/1024:.1f}KB → {optimized_size/1024:.1f}KB ({reduction:.1f}% menos)")
        return optimized_bytes, original_size, optimized_size, '.webp'
        
    except Exception as e:
        logger.error(f"❌ Error optimizando imagen: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return image_bytes, len(image_bytes), len(image_bytes), '.webp'


def generate_file_hash(evidence_id, url, operation_code=None):
    """Genera un hash único basado en evidence_id + operation_code"""
    unique_string = f"{evidence_id}_{operation_code or url}"
    hash_object = hashlib.sha256(unique_string.encode())
    return hash_object.hexdigest()[:16]


def download_image(url, session):
    """Descarga la imagen desde la URL con reintentos"""
    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.content
    except requests.exceptions.Timeout:
        logger.warning(f"️ Timeout descargando {url[:80]}...")
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Error descargando {url[:80]}...: {e}")
    return None


def upload_to_s3(s3_client, file_bytes, key, content_type='image/webp'):
    """Sube el archivo a S3"""
    try:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )
        return True
    except ClientError as e:
        logger.error(f"❌ Error subiendo {key} a S3: {e}")
        return False
    except Exception as e:
        logger.error(f" Error inesperado subiendo {key}: {e}")
        return False


def build_s3_key(evidence_id, created_at, operation_code, url, file_ext='.webp'):
    """Construye la ruta S3: liquidation/motorized/YYYY/MM/DD/hash.ext"""
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
    
    file_hash = generate_file_hash(evidence_id, url, operation_code)
    
    key = f"{S3_PREFIX}/{year:04d}/{month:02d}/{day:02d}/{file_hash}{file_ext}"
    return key


def build_s3_url(bucket, region, key):
    """Construye la URL completa de S3"""
    return f"https://{bucket}.s3.{region}.amazonaws.com/{key}"


def append_to_csv(row):
    """Agrega una fila al CSV inmediatamente"""
    file_exists = os.path.isfile(MIGRATION_LOG_FILE)
    file_empty = file_exists and os.path.getsize(MIGRATION_LOG_FILE) == 0

    with open(MIGRATION_LOG_FILE, 'a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
        if not file_exists or file_empty:
            writer.writeheader()
        writer.writerow(row)
        f.flush()


def load_already_migrated_ids():
    """Lee el CSV existente y retorna un set con los evidence_id ya migrados exitosamente"""
    migrated_ids = set()
    
    if not os.path.isfile(MIGRATION_LOG_FILE):
        logger.info("📄 No se encontró CSV previo. Se iniciará desde cero.")
        return migrated_ids
    
    try:
        with open(MIGRATION_LOG_FILE, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row.get('status', '').strip().lower() == 'success':
                    try:
                        migrated_ids.add(int(row['evidence_id']))
                    except (ValueError, KeyError):
                        continue
        
        logger.info(f"📊 Se encontraron {len(migrated_ids):,} vouchers ya migrados exitosamente en el CSV.")
    except Exception as e:
        logger.error(f"❌ Error leyendo CSV previo: {e}")
    
    return migrated_ids


def migrate_evidence(s3_client, session, evidence_id, voucher_url, created_at, operation_code):
    """Migra un voucher individual con optimización a WebP"""
    image_data = download_image(voucher_url, session)
    if not image_data:
        result = {
            'evidence_id': evidence_id,
            'status': 'failed',
            's3_key': '',
            'new_url': '',
            'original_size': 0,
            'optimized_size': 0,
            'message': 'Error descargando voucher'
        }
        append_to_csv(result)
        return result
    
    original_size = len(image_data)
    
    # Detectar formato original
    try:
        img = Image.open(io.BytesIO(image_data))
        original_format = img.format or 'JPEG'
    except:
        original_format = 'JPEG'
    
    # Optimizar imagen (Todo a WebP)
    logger.info(f" Procesando evidencia {evidence_id} (formato original: {original_format})...")
    optimized_data, orig_size, opt_size, file_ext = optimize_image(image_data, original_format)
    
    # Construir key S3
    s3_key = build_s3_key(evidence_id, created_at, operation_code, voucher_url, file_ext)
    new_url = build_s3_url(S3_BUCKET, S3_REGION, s3_key)
    
    # Content-type siempre será webp
    content_type = 'image/webp'
    
    # Subir a S3
    success = upload_to_s3(s3_client, optimized_data, s3_key, content_type)
    
    if success:
        reduction = ((orig_size - opt_size) / orig_size) * 100 if orig_size > 0 else 0
        result = {
            'evidence_id': evidence_id,
            'status': 'success',
            's3_key': s3_key,
            'new_url': new_url,
            'original_size': orig_size,
            'optimized_size': opt_size,
            'message': f'Migrado exitosamente a WebP ({reduction:.1f}% reducción)'
        }
        logger.info(f"✅ Evidencia {evidence_id} migrada: {orig_size/1024:.1f}KB → {opt_size/1024:.1f}KB ({reduction:.1f}% menos)")
    else:
        result = {
            'evidence_id': evidence_id,
            'status': 'failed',
            's3_key': s3_key,
            'new_url': '',
            'original_size': orig_size,
            'optimized_size': 0,
            'message': 'Error subiendo a S3'
        }
    
    append_to_csv(result)
    return result


def get_evidence_count(cursor):
    """Obtiene el total de vouchers a migrar"""
    cursor.execute("""
        SELECT COUNT(*) 
        FROM EvidenceLiquidation
        WHERE voucherUrl IS NOT NULL
          AND voucherUrl != ''
          AND isActive = 1
    """)
    return cursor.fetchone()[0]


def fetch_batch_optimized(cursor, batch_size, last_id, exclude_ids=None):
    """
    Obtiene un batch de vouchers usando paginación por ID (más eficiente que OFFSET)
    Evita el uso de NOT IN con miles de IDs que causa timeout en Vitess
    """
    if exclude_ids and len(exclude_ids) > 0:
        # Estrategia: traer más registros y filtrar en Python
        # Esto es MÁS rápido que NOT IN gigante en Vitess
        query = """
            SELECT id, voucherUrl, createdAt, operationCode
            FROM EvidenceLiquidation
            WHERE voucherUrl IS NOT NULL
              AND voucherUrl != ''
              AND isActive = 1
              AND id > %s
            ORDER BY id
            LIMIT %s
        """
        cursor.execute(query, (last_id, batch_size * 3))  # Traer 3x para compensar filtros
        rows = cursor.fetchall()
        
        # Filtrar en Python (mucho más rápido que NOT IN gigante)
        filtered = [row for row in rows if row[0] not in exclude_ids]
        return filtered[:batch_size]
    else:
        query = """
            SELECT id, voucherUrl, createdAt, operationCode
            FROM EvidenceLiquidation
            WHERE voucherUrl IS NOT NULL
              AND voucherUrl != ''
              AND isActive = 1
              AND id > %s
            ORDER BY id
            LIMIT %s
        """
        cursor.execute(query, (last_id, batch_size))
        return cursor.fetchall()


def main():
    """Función principal"""
    global running

    logger.info("=" * 70)
    logger.info("🚀 INICIANDO MIGRACIÓN DE VOUCHERS (EvidenceLiquidation) A S3")
    logger.info(" CON OPTIMIZACIÓN TOTAL A WEBP")
    logger.info("=" * 70)
    logger.info("⚠️  MODO: Solo lectura de BD + escritura en S3. NO se actualiza la BD.")
    logger.info(f"🖼️  Configuración de optimización:")
    logger.info(f"   - Dimensiones máximas: {IMAGE_CONFIG['max_width']}x{IMAGE_CONFIG['max_height']}px")
    logger.info(f"   - Calidad WebP: {IMAGE_CONFIG['quality']}%")
    logger.info(f"   - Formato final: WebP (animado o estático)")
    logger.info(f" Bucket S3: {S3_BUCKET}")
    logger.info(f"📁 Prefijo S3: {S3_PREFIX}")
    logger.info(f"📄 CSV se guardará en: {os.path.abspath(MIGRATION_LOG_FILE)}")
    logger.info(f"📊 Batch size: {BATCH_SIZE}")
    logger.info("=" * 70)

    # Cargar IDs ya migrados
    migrated_ids = load_already_migrated_ids()

    # Inicializar S3
    s3_client = init_s3()
    if not s3_client:
        return

    # Crear sesión HTTP
    session = create_http_session()

    # Conectar a BD
    conn = get_db_connection()
    if not conn:
        return

    cursor = conn.cursor()

    try:
        # Obtener último ID procesado del CSV
        last_id = 0
        if migrated_ids:
            last_id = max(migrated_ids)
            logger.info(f"📍 Último ID procesado: {last_id}")
        
        total_records = get_evidence_count(cursor)
        pending_records = total_records - len(migrated_ids)
        logger.info(f"📋 Total de vouchers en BD: {total_records:,}")
        logger.info(f" Total de vouchers pendientes: {pending_records:,}")
        
        if pending_records == 0:
            logger.info("✅ No hay vouchers pendientes. La migración ya está completa.")
            return

        total_success = 0
        total_failed = 0
        total_original_size = 0
        total_optimized_size = 0
        batch_num = 0
        start_time = time.time()
        current_id = last_id
        
        while running:
            batch_num += 1
            batch = fetch_batch_optimized(cursor, BATCH_SIZE, current_id, migrated_ids if migrated_ids else None)
            
            if not batch:
                logger.info("✅ No hay más registros para procesar")
                break
            
            # Actualizar current_id al último ID del batch
            current_id = batch[-1][0]
            
            logger.info(f" Batch {batch_num}: Procesando {len(batch)} vouchers (desde ID {current_id})")
            
            for evidence in batch:
                if not running:
                    logger.info("⚠️  Migración detenida por usuario")
                    break
                
                evidence_id, voucher_url, created_at, operation_code = evidence
                
                result = migrate_evidence(
                    s3_client, session, evidence_id, voucher_url, created_at, operation_code
                )
                
                if result['status'] == 'success':
                    total_success += 1
                    migrated_ids.add(evidence_id)
                    total_original_size += result['original_size']
                    total_optimized_size += result['optimized_size']
                else:
                    total_failed += 1
                
                time.sleep(RATE_LIMIT_DELAY)
            
            # Log de progreso
            elapsed = time.time() - start_time
            processed = total_success + total_failed
            logger.info(
                f"📊 Progreso: {processed:,} procesados | "
                f"✅ {total_success:,} | ❌ {total_failed:,} | "
                f"⏱️  {elapsed/60:.1f} min | 📍 Último ID: {current_id}"
            )

        # Resumen final
        elapsed = time.time() - start_time
        total_reduction = ((total_original_size - total_optimized_size) / total_original_size) * 100 if total_original_size > 0 else 0
        
        logger.info("=" * 70)
        logger.info("📊 MIGRACIÓN COMPLETADA")
        logger.info(f"✅ Exitosos en esta corrida: {total_success:,}")
        logger.info(f"❌ Fallidos en esta corrida: {total_failed:,}")
        logger.info(f" Total procesados en esta corrida: {total_success + total_failed:,}")
        logger.info(f" Total migrados (acumulado): {len(migrated_ids):,}")
        logger.info(f"💾 Tamaño original total: {total_original_size / (1024*1024):.2f} MB")
        logger.info(f"💾 Tamaño optimizado total: {total_optimized_size / (1024*1024):.2f} MB")
        logger.info(f"💰 Ahorro de espacio: {total_reduction:.1f}% ({(total_original_size - total_optimized_size) / (1024*1024):.2f} MB)")
        logger.info(f"⏱️  Tiempo de esta corrida: {elapsed/60:.1f} minutos")
        logger.info(f"📄 CSV guardado en: {os.path.abspath(MIGRATION_LOG_FILE)}")
        logger.info("=" * 70)

    except MySQLError as e:
        logger.error(f"❌ Error de MySQL: {e}")
    except Exception as e:
        logger.error(f"❌ Error inesperado: {e}")
        import traceback
        logger.error(traceback.format_exc())
    finally:
        cursor.close()
        conn.close()
        session.close()
        logger.info("🔌 Conexiones cerradas")


if __name__ == "__main__":
    main()