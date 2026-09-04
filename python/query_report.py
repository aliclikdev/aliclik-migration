#!/usr/bin/env python3
"""
Script para exportar reporte de pedidos entregados en bloques CSV
VERSIÓN OPTIMIZADA: Sin COUNT inicial (evita timeout)
"""

import os
import sys
import time
import logging
import csv
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List

from dotenv import load_dotenv
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(dotenv_path=env_path, override=True)

import mysql.connector
from mysql.connector import Error

# Cargar variables de entorno
load_dotenv()

# ============================================================
# CONFIGURACIÓN
# ============================================================

DB_CONFIG = {
    'host': os.getenv('DB_HOST_LEGACY'),
    'port': int(os.getenv('DB_PORT_LEGACY', 3306)),
    'user': os.getenv('DB_USER_LEGACY'),
    'password': os.getenv('DB_PASS_LEGACY'),
    'database': os.getenv('DB_NAME_LEGACY'),
    'charset': 'utf8mb4',
}


EXPORT_CONFIG = {
    'output_dir': os.getenv('OUTPUT_DIR', './export_reportes'),
    'block_size': int(os.getenv('BLOCK_SIZE', '10000')),  # ✅ Bloques de 10k
    'max_blocks': int(os.getenv('MAX_BLOCKS', '0')),  # 0 = sin límite
    'file_prefix': 'pedidos_agosto_2026',
    'encoding': 'utf-8-sig',
    'delete_csvs_after_zip': os.getenv('DELETE_CSVS', 'true').lower() == 'true',
}

# ============================================================
# QUERY (sin cambios)
# ============================================================

QUERY_BASE = """
SELECT 
  o.id AS orderId,
  o.orderNumber,
  o.channel,
  o.createdAtShopify AS shopifyDate,
  s.scheduleDate AS fecha_programada,
  s.dispatchDate AS fecha_despacho,
  o.status AS deliveryStatus,
  o.trackingStatus,
  o.callStatus,
  o.isOrderAgency,
  o.managementType,
  o.warehouseName AS almacen,
  s.countryName AS pais,
  s.departmentName AS departamento,
  s.provinceName AS provincia,
  s.districtName AS distrito,
  u.email AS email_vendedor,
  u.fullname AS nombre_vendedor,
  c.name AS tienda,
  o.companyId,
  o.transporterId,
  t.name AS courier,
  od.skuId,
  sk.sku AS sku_code,
  sk.ean,
  p.name AS productName,
  od.quantity,
  od.dropPrice AS precio_drop,
  od.subtotal / NULLIF(od.quantity, 0) AS precio_venta,
  sk.purchasePrice AS precio_compra,
  CASE WHEN od.companyId <> o.companyId THEN 1 ELSE 0 END AS isDrop,
  od.companyId AS proveedor_id,
  c2.name AS dropshipper,
  o.total AS total_pedido,
  o.shippingCost AS costo_envio,
  o.returnCost AS costo_retorno,
  o.additionalDeliveryCost AS costo_adicional,
  o.recycleCost AS costo_reciclaje,
  COALESCE(pay.cash_payment, 0) AS pago_efectivo,
  COALESCE(pay.transfer_payment, 0) AS pago_transferencia,
  COALESCE(pay.pos_payment, 0) AS pago_pos,
  (od.quantity * od.dropPrice) AS subtotal_drop

FROM `Order` o
INNER JOIN Shipping s 
  ON o.id = s.orderId
  AND s.scheduleDate >= '2026-08-01'
  AND s.scheduleDate < '2026-09-01'
  AND s.countryName = 'Perú'

INNER JOIN OrderDetail od 
  ON o.id = od.orderId
  AND od.isActive = 1

LEFT JOIN Sku sk 
  ON od.skuId = sk.id

LEFT JOIN Product p 
  ON sk.productId = p.id

LEFT JOIN Company c 
  ON o.companyId = c.id

LEFT JOIN Company c2 
  ON od.companyId = c2.id

LEFT JOIN Transporter t 
  ON o.transporterId = t.id

LEFT JOIN User u 
  ON o.userId = u.id

LEFT JOIN (
  SELECT 
    orderId,
    SUM(CASE WHEN paymentMethod = 'E' AND isPayMain = 1 THEN amount ELSE 0 END) AS cash_payment,
    SUM(CASE WHEN paymentMethod = 'T' AND isPayMain = 1 THEN amount ELSE 0 END) AS transfer_payment,
    SUM(CASE WHEN paymentMethod = 'P' AND isPayMain = 1 THEN amount ELSE 0 END) AS pos_payment
  FROM Payment
  WHERE isActive = 1
  GROUP BY orderId
) pay 
  ON pay.orderId = o.id

WHERE o.status = 'DELIVERED'
  AND o.callStatus = 'CONFIRMED'
  AND o.isOrderAgency = 0
  AND o.countryCode = 'PER'

ORDER BY s.scheduleDate DESC, o.orderNumber, sk.sku
"""

# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('export_reporte.log', encoding='utf-8')
    ]
)
logger = logging.getLogger(__name__)


# ============================================================
# CLASE PRINCIPAL
# ============================================================

class ReportExporter:
    def __init__(self):
        self.conn = None
        self.output_dir = Path(EXPORT_CONFIG['output_dir'])
        self.block_size = EXPORT_CONFIG['block_size']
        self.max_blocks = EXPORT_CONFIG['max_blocks']
        self.file_prefix = EXPORT_CONFIG['file_prefix']
        self.encoding = EXPORT_CONFIG['encoding']
        self.delete_csvs = EXPORT_CONFIG['delete_csvs_after_zip']
        
        self.output_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"Directorio de salida: {self.output_dir.absolute()}")
    
    def connect(self) -> bool:
        try:
            self.conn = mysql.connector.connect(**DB_CONFIG)
            if self.conn.is_connected():
                logger.info(f"Conectado a MySQL")
                return True
        except Error as e:
            logger.error(f"Error al conectar: {e}")
            return False
    
    def disconnect(self):
        if self.conn and self.conn.is_connected():
            self.conn.close()
            logger.info("Conexión cerrada")
    
    def reconnect(self) -> bool:
        logger.warning("Intentando reconectar...")
        self.disconnect()
        time.sleep(2)
        return self.connect()
    
    def export_block(self, block_num: int, offset: int) -> tuple:
        """
        Exporta un bloque de filas a CSV
        Retorna: (rows_exported, is_last_block)
        """
        query = f"{QUERY_BASE} LIMIT {self.block_size} OFFSET {offset}"
        filename = f"{self.file_prefix}_block_{block_num:03d}.csv"
        filepath = self.output_dir / filename
        
        rows_exported = 0
        is_last_block = False
        
        try:
            cursor = self.conn.cursor(buffered=False)
            cursor.execute(query)
            headers = [desc[0] for desc in cursor.description]
            
            with open(filepath, 'w', newline='', encoding=self.encoding) as csvfile:
                writer = csv.writer(csvfile)
                writer.writerow(headers)
                
                for row in cursor:
                    csv_row = []
                    for value in row:
                        if value is None:
                            csv_row.append('')
                        elif isinstance(value, datetime):
                            csv_row.append(value.strftime('%Y-%m-%d %H:%M:%S'))
                        elif isinstance(value, bytes):
                            csv_row.append(value.decode('utf-8', errors='ignore'))
                        else:
                            csv_row.append(str(value))
                    writer.writerow(csv_row)
                    rows_exported += 1
            
            cursor.close()
            
            # Si obtuvo menos filas de las solicitadas, es el último bloque
            if rows_exported < self.block_size:
                is_last_block = True
            
            file_size_mb = filepath.stat().st_size / (1024 * 1024)
            logger.info(f"✓ Bloque {block_num:03d}: {rows_exported:,} filas | {filepath.name} ({file_size_mb:.2f} MB)")
            
            return rows_exported, is_last_block
            
        except Error as e:
            logger.error(f"Error en bloque {block_num}: {e}")
            if self.reconnect():
                return self.export_block(block_num, offset)
            return 0, False
    
    def compress_to_zip(self, csv_files: List[Path]) -> Path:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        zip_filename = f"{self.file_prefix}_completo_{timestamp}.zip"
        zip_path = self.output_dir / zip_filename
        
        logger.info(f"📦 Comprimiendo {len(csv_files)} archivos CSV...")
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for csv_file in csv_files:
                zipf.write(csv_file, arcname=csv_file.name)
                
                if self.delete_csvs:
                    csv_file.unlink()
                    logger.debug(f"  Eliminado: {csv_file.name}")
        
        zip_size_mb = zip_path.stat().st_size / (1024 * 1024)
        logger.info(f"✅ ZIP generado: {zip_path.name} ({zip_size_mb:.2f} MB)")
        return zip_path
    
    def export_all(self):
        # ✅ SIN COUNT INICIAL - Streaming directo
        if not self.connect():
            logger.error("No se pudo conectar a la base de datos")
            return
        
        try:
            logger.info(f"Tamaño de bloque: {self.block_size:,} filas")
            if self.max_blocks > 0:
                logger.info(f"Límite máximo: {self.max_blocks} bloques")
            logger.info("=" * 60)
            
            start_time = time.time()
            total_exported = 0
            csv_files = []
            block_num = 1
            offset = 0
            
            while True:
                logger.info(f"Procesando bloque {block_num} (offset: {offset:,})...")
                
                rows, is_last = self.export_block(block_num, offset)
                
                if rows == 0:
                    logger.info("✓ No hay más datos para exportar")
                    break
                
                total_exported += rows
                csv_files.append(self.output_dir / f"{self.file_prefix}_block_{block_num:03d}.csv")
                
                # Verificar límite máximo de bloques
                if self.max_blocks > 0 and block_num >= self.max_blocks:
                    logger.warning(f"⚠️ Alcanzado el límite de {self.max_blocks} bloques")
                    break
                
                if is_last:
                    logger.info("✓ Último bloque procesado")
                    break
                
                # Siguiente bloque
                block_num += 1
                offset += self.block_size
                
                # Pausa entre bloques
                time.sleep(0.5)
            
            # Comprimir al finalizar
            if csv_files:
                self.compress_to_zip(csv_files)
            
            elapsed = time.time() - start_time
            logger.info("=" * 60)
            logger.info("EXPORTACIÓN COMPLETADA")
            logger.info(f"Total de filas exportadas: {total_exported:,}")
            logger.info(f"Archivos CSV generados: {len(csv_files)}")
            logger.info(f"Tiempo total: {elapsed:.2f} segundos")
            if elapsed > 0:
                logger.info(f"Velocidad promedio: {total_exported/elapsed:,.0f} filas/seg")
            logger.info(f"Archivos guardados en: {self.output_dir.absolute()}")
            
        except Exception as e:
            logger.error(f"Error fatal: {e}", exc_info=True)
        finally:
            self.disconnect()


# ============================================================
# MAIN
# ============================================================

def main():
    logger.info("=" * 60)
    logger.info("INICIANDO EXPORTACIÓN DE REPORTE")
    logger.info(f"Fecha: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 60)
    
    exporter = ReportExporter()
    exporter.export_all()
    
    logger.info("Proceso finalizado")


if __name__ == '__main__':
    main()