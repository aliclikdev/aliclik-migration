import os
import io
import logging
import mysql.connector
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, storage
import boto3
from botocore.exceptions import ClientError

# Configuración de Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Cargar variables de entorno (.env)
load_dotenv()

# --- CONFIGURACIÓN FIREBASE ---
FIREBASE_CREDENTIALS_PATH = os.getenv('FIREBASE_CREDENTIALS_PATH', 'firebase-adminsdk.json')
FIREBASE_BUCKET_NAME = os.getenv('FIREBASE_BUCKET_NAME') # Ej: wanklik-platform.appspot.com

# --- CONFIGURACIÓN AWS S3 ---
AWS_ACCESS_KEY_ID = os.getenv('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = os.getenv('AWS_SECRET_ACCESS_KEY')
AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
S3_BUCKET_NAME = os.getenv('S3_BUCKET_NAME') # Tu bucket destino

# --- CONFIGURACIÓN DB (MySQL) ---
DB_HOST = os.getenv('DB_HOST')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

def init_firebase():
    try:
        cred = credentials.Certificate(FIREBASE_CREDENTIALS_PATH)
        firebase_admin.initialize_app(cred, {
            'storageBucket': FIREBASE_BUCKET_NAME
        })
        logger.info("Firebase inicializado correctamente.")
    except Exception as e:
        logger.error(f"Error inicializando Firebase: {e}")
        raise

def get_s3_client():
    return boto3.client(
        's3',
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION
    )

def get_db_connection():
    """
    Parsea AURORA_DATABASE_URL para conectar a MySQL
    Formato esperado: mysql://user:password@host:port/database
    """
    db_url = os.getenv('AURORA_DATABASE_URL')
    if not db_url:
        raise ValueError("Falta la variable de entorno AURORA_DATABASE_URL")
    
    parsed = urlparse(db_url)
    
    return mysql.connector.connect(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=parsed.username,
        password=parsed.password,
        database=parsed.path.lstrip('/') # Elimina la barra inicial del path
    )

def migrate_single_product(product_id, current_url, s3_key):
    """
    Migra una sola imagen: Firebase -> S3 -> Update DB
    """
    s3_client = get_s3_client()
    
    try:
        # 1. Descargar desde Firebase
        bucket = storage.bucket()
        blob = bucket.blob(current_url.split(f'{FIREBASE_BUCKET_NAME}/o/')[-1].split('?')[0]) 
        # Nota: Ajusta el parsing del blob path según cómo guardes las URLs en tu DB. 
        # Si en DB guardas solo el path relativo, usa ese directamente.
        
        # Descarga a memoria
        image_data = blob.download_as_bytes()
        
        # 2. Subir a S3
        s3_client.put_object(
            Bucket=S3_BUCKET_NAME,
            Key=s3_key,
            Body=image_data,
            ContentType='image/jpeg', # O detectar dinámicamente si es png/webp
            ACL='public-read' # Opcional, depende de tu config de bucket
        )
        
        new_url = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"
        
        # 3. Actualizar MySQL
        conn = get_db_connection()
        cursor = conn.cursor()
        query = "UPDATE Product SET urlImage = %s WHERE id = %s"
        cursor.execute(query, (new_url, product_id))
        conn.commit()
        cursor.close()
        conn.close()
        
        logger.info(f"Producto {product_id} migrado exitosamente a {new_url}")
        return True

    except ClientError as e:
        logger.error(f"Error AWS S3 para producto {product_id}: {e}")
        return False
    except Exception as e:
        logger.error(f"Error general para producto {product_id}: {e}")
        return False

def main():
    init_firebase()
    
    # Conectar a DB para obtener lista de productos pendientes
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    # AJUSTA ESTA QUERY: Trae los productos que quieres migrar
    # Ejemplo: Todos los productos activos
    cursor.execute("SELECT id, urlImage FROM Product WHERE isActive = 1 AND urlImage IS NOT NULL LIMIT 100") 
    products = cursor.fetchall()
    
    logger.info(f"Iniciando migración de {len(products)} productos...")
    
    success_count = 0
    fail_count = 0

    for product in products:
        pid = product['id']
        current_url = product['urlImage']
        
        # Generar nueva key para S3 (Ej: products/ID.jpg)
        # Puedes mejorar esto para mantener la extensión original si varía
        s3_key = f"products/{pid}.jpg" 
        
        if migrate_single_product(pid, current_url, s3_key):
            success_count += 1
        else:
            fail_count += 1
            
    logger.info(f"Migración finalizada. Éxitos: {success_count}, Fallos: {fail_count}")
    
    cursor.close()
    conn.close()

if __name__ == "__main__":
    main()