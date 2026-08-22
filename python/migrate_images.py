import os
from urllib.parse import quote
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, storage

# Cargar variables de entorno
load_dotenv()

FIREBASE_CREDENTIALS_PATH = os.getenv('FIREBASE_CREDENTIALS_PATH', './firebase-adminsdk.json')
FIREBASE_BUCKET_NAME = os.getenv('FIREBASE_BUCKET_NAME')

def init_firebase():
    """Inicializa la conexión con Firebase evitando duplicados"""
    try:
        if firebase_admin._apps:
            return True

        if not os.path.exists(FIREBASE_CREDENTIALS_PATH):
            print(f"❌ No se encontró el archivo de credenciales: {FIREBASE_CREDENTIALS_PATH}")
            return False
            
        cred = credentials.Certificate(FIREBASE_CREDENTIALS_PATH)
        firebase_admin.initialize_app(cred, {
            'storageBucket': FIREBASE_BUCKET_NAME
        })
        print(f"✅ Conexión exitosa con Firebase")
        print(f"   Bucket: {FIREBASE_BUCKET_NAME}")
        return True
    except Exception as e:
        print(f"❌ Error al conectar con Firebase: {e}")
        return False

def format_size(size_bytes):
    """Formatea el tamaño en bytes a una representación legible"""
    if size_bytes is None or size_bytes == 0:
        return "0 B"
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f} TB"

def get_int_input(prompt, default):
    """Valida entradas numéricas del usuario"""
    val = input(prompt).strip()
    if not val:
        return default
    try:
        return int(val)
    except ValueError:
        print(f"⚠️ Valor inválido, usando default: {default}")
        return default

def get_firebase_url(bucket_name, blob_name):
    """Genera la URL pública nativa de Firebase Storage"""
    encoded_name = quote(blob_name, safe='')
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded_name}?alt=media"

def list_images(prefix=None, limit=100, detailed=False):
    """Lista las imágenes del bucket de Firebase Storage"""
    try:
        bucket = storage.bucket()
        blobs = bucket.list_blobs(max_results=limit, prefix=prefix)
        
        print(f"\n📋 Listando imágenes" + (f" con prefijo '{prefix}'" if prefix else ""))
        print(f"   Máximo: {limit} imágenes")
        print("=" * 80)
        
        count = 0
        total_size = 0
        images_by_extension = {}
        
        for blob in blobs:
            count += 1
            size_bytes = blob.size if blob.size else 0
            total_size += size_bytes
            
            ext = os.path.splitext(blob.name)[1].lower() or 'sin_ext'
            images_by_extension[ext] = images_by_extension.get(ext, 0) + 1
            
            if detailed:
                updated = blob.updated.strftime('%Y-%m-%d %H:%M:%S') if blob.updated else 'N/A'
                created = blob.time_created.strftime('%Y-%m-%d %H:%M:%S') if blob.time_created else 'N/A'
                public_url = get_firebase_url(bucket.name, blob.name)
                
                print(f"\n{count}. {blob.name}")
                print(f"   📏 Tamaño: {format_size(size_bytes)}")
                print(f"   📅 Creado: {created}")
                print(f"   🔄 Actualizado: {updated}")
                print(f"   🔗 URL Firebase: {public_url}")
                print(f"   🏷️  Content-Type: {blob.content_type or 'N/A'}")
            else:
                size_str = format_size(size_bytes)
                print(f"{count:3d}. {blob.name:<60} {size_str:>10}")
        
        print("\n" + "=" * 80)
        print(f"📊 RESUMEN:")
        print(f"   Total de imágenes: {count}")
        print(f"   Tamaño total: {format_size(total_size)}")
        
        if images_by_extension:
            print(f"\n   Por extensión:")
            for ext, qty in sorted(images_by_extension.items()):
                print(f"      {ext}: {qty}")
        
        return count
        
    except Exception as e:
        print(f"❌ Error al listar imágenes: {e}")
        return 0

def search_images(pattern, limit=50):
    """Busca imágenes que contengan el patrón en el nombre"""
    try:
        bucket = storage.bucket()
        blobs = bucket.list_blobs()
        
        results = []
        pattern_lower = pattern.lower()
        
        for blob in blobs:
            if pattern_lower in blob.name.lower():
                results.append(blob)
                if len(results) >= limit:
                    break
        
        if not results:
            print(f"\n❌ No se encontraron imágenes que contengan '{pattern}'")
            return 0
        
        print(f"\n🔍 Resultados de búsqueda para '{pattern}':")
        print("=" * 80)
        
        for i, blob in enumerate(results, 1):
            size_str = format_size(blob.size if blob.size else 0)
            url = get_firebase_url(bucket.name, blob.name)
            print(f"{i:3d}. {blob.name:<50} {size_str:>10}")
            print(f"     🔗 {url}")
        
        print(f"\n✅ Encontradas {len(results)} imágenes")
        return len(results)
        
    except Exception as e:
        print(f"❌ Error en la búsqueda: {e}")
        return 0

def show_statistics():
    """Muestra estadísticas completas del bucket"""
    try:
        bucket = storage.bucket()
        blobs = bucket.list_blobs()
        
        total_size = 0
        count = 0
        extensions = {}
        folders = {}
        
        print("\n⏳ Calculando estadísticas del bucket...")
        print("Esto puede tomar unos segundos...\n")
        
        for blob in blobs:
            count += 1
            size_bytes = blob.size if blob.size else 0
            total_size += size_bytes
            
            ext = os.path.splitext(blob.name)[1].lower() or 'sin_ext'
            extensions[ext] = extensions.get(ext, 0) + 1
            
            parts = blob.name.split('/')
            if len(parts) > 1:
                folder = parts[0] + '/'
                folders[folder] = folders.get(folder, 0) + 1
        
        print("=" * 80)
        print("📈 ESTADÍSTICAS DEL BUCKET")
        print("=" * 80)
        print(f"\n Total de archivos: {count}")
        print(f"💾 Tamaño total: {format_size(total_size)}")
        
        if folders:
            print(f"\n📁 Por carpetas principales (top 10):")
            sorted_folders = sorted(folders.items(), key=lambda x: x[1], reverse=True)[:10]
            for folder, qty in sorted_folders:
                print(f"   {folder:<40} {qty:>5} archivos")
        
        if extensions:
            print(f"\n🏷️  Por extensión:")
            sorted_ext = sorted(extensions.items(), key=lambda x: x[1], reverse=True)
            for ext, qty in sorted_ext:
                print(f"   {ext:<10} {qty:>5} archivos")
        
        print("=" * 80)
        return count
        
    except Exception as e:
        print(f"❌ Error al obtener estadísticas: {e}")
        return 0

def main():
    if not init_firebase():
        return
    
    while True:
        print("\n" + "=" * 80)
        print("🔧 MENÚ PRINCIPAL - Firebase Storage")
        print("=" * 80)
        print("1. Listar imágenes (primeras 100)")
        print("2. Listar con prefijo específico")
        print("3. Listar con información detallada y URLs")
        print("4. Buscar imágenes por nombre")
        print("5. Ver estadísticas del bucket")
        print("6. Salir")
        print("=" * 80)
        
        try:
            choice = input("\nSelecciona una opción (1-6): ").strip()
            
            if choice == '1':
                list_images(limit=100, detailed=False)
            
            elif choice == '2':
                prefix = input("Ingresa el prefijo (ej: 'products/', 'uploads/'): ").strip()
                if prefix:
                    limit = get_int_input("Número máximo de imágenes (default 100): ", 100)
                    list_images(prefix=prefix, limit=limit, detailed=False)
                else:
                    print("⚠️ Debes ingresar un prefijo")
            
            elif choice == '3':
                prefix = input("Prefijo opcional (dejar vacío para todo): ").strip() or None
                limit = get_int_input("Número máximo de imágenes (default 50): ", 50)
                list_images(prefix=prefix, limit=limit, detailed=True)
            
            elif choice == '4':
                pattern = input("Ingresa el patrón a buscar: ").strip()
                if pattern:
                    limit = get_int_input("Número máximo de resultados (default 50): ", 50)
                    search_images(pattern, limit=limit)
                else:
                    print("❌ Debes ingresar un patrón de búsqueda")
            
            elif choice == '5':
                show_statistics()
            
            elif choice == '6':
                print("\n👋 ¡Hasta luego!")
                break
            
            else:
                print("❌ Opción no válida. Intenta de nuevo.")
        
        except KeyboardInterrupt:
            print("\n\n👋 ¡Hasta luego!")
            break
        except Exception as e:
            print(f"❌ Error inesperado: {e}")

if __name__ == "__main__":
    main()