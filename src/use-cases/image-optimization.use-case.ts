// src/use-cases/image-optimization.use-case.ts

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { createHash } from "crypto";
import { ImageOptimizationMessage } from "../types/image-optimization.types";
import { getAuroraDb } from "../services/aurora.service";
import { logger } from "../utils/logger";

const S3_BUCKET = process.env.AWS_S3_BUCKET!;
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const S3_PUBLIC_BASE = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

// Calidad alta para no perder calidad visual
const WEBP_QUALITY = 88;

export interface OptimizationResult {
  success: boolean;
  s3Key?: string;
  newUrl?: string;
  originalSize?: number;
  optimizedSize?: number;
  savingsPercent?: number;
  error?: string;
}

export class ImageOptimizationUseCase {
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client({ region: S3_REGION });
  }

  async execute(
    message: ImageOptimizationMessage,
  ): Promise<OptimizationResult> {
    const { image, timestamp } = message;

    try {
      // 1. Descargar imagen original desde staging
      const { buffer, contentType } = await this.downloadFromStaging(
        image.stagingS3Key,
      );
      if (!buffer) {
        return {
          success: false,
          error: `No se pudo descargar ${image.stagingS3Key}`,
        };
      }

      const originalSize = buffer.length;
      const ext = this.getExtension(image.stagingS3Key);
      const isAlreadyWebp = ext === ".webp";

      // 2. Optimizar (solo si no es WebP)
      let optimizedBuffer: Buffer;
      let finalExt: string;
      let finalContentType: string;

      if (isAlreadyWebp) {
        // Ya es WebP, solo strip metadata sin reprocesar
        optimizedBuffer = await sharp(buffer).strip().toBuffer();
        finalExt = ".webp";
        finalContentType = "image/webp";
      } else {
        // Convertir a WebP con calidad alta
        optimizedBuffer = await sharp(buffer)
          .rotate() // auto-rotar según EXIF
          .webp({ quality: WEBP_QUALITY, effort: 4 })
          .strip() // eliminar EXIF/metadata
          .toBuffer();
        finalExt = ".webp";
        finalContentType = "image/webp";
      }

      // 3. Construir key final: {año}/{mes}/{dia}/{hash}.webp
      const hash = this.hashBuffer(optimizedBuffer);
      const date = this.buildDatePath(image.uploadedAt || timestamp);
      const finalKey = `${date}/${hash}${finalExt}`;

      // 4. Subir a S3
      const uploaded = await this.uploadToS3(
        optimizedBuffer,
        finalKey,
        finalContentType,
      );
      if (!uploaded) {
        return {
          success: false,
          error: "Error subiendo imagen optimizada a S3",
        };
      }

      // 5. Borrar del staging (cleanup)
      await this.deleteFromStaging(image.stagingS3Key);

      // 6. Actualizar BD legacy
      const newUrl = `${S3_PUBLIC_BASE}/${finalKey}`;
      const updated = await this.updateLegacyDb(image, newUrl);
      if (!updated) {
        logger.warn({
          msg: "Imagen optimizada en S3 pero no se pudo actualizar BD",
          finalKey,
          entityId: image.entityId,
        });
        return {
          success: false,
          s3Key: finalKey,
          newUrl,
          error: "Error actualizando BD legacy",
        };
      }

      const optimizedSize = optimizedBuffer.length;
      const savingsPercent = Math.round(
        (1 - optimizedSize / originalSize) * 100,
      );

      logger.info({
        msg: "Imagen optimizada exitosamente",
        entityId: image.entityId,
        originalSize,
        optimizedSize,
        savingsPercent,
        finalKey,
      });

      return {
        success: true,
        s3Key: finalKey,
        newUrl,
        originalSize,
        optimizedSize,
        savingsPercent,
      };
    } catch (e) {
      logger.error({
        msg: "Error inesperado optimizando imagen",
        entityId: image.entityId,
        error: (e as Error).message,
      });
      return { success: false, error: (e as Error).message };
    }
  }

  // --- Helpers ---

  private async downloadFromStaging(
    key: string,
  ): Promise<{ buffer: Buffer | null; contentType: string | null }> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      );
      const stream = res.Body as NodeJS.ReadableStream;
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return {
        buffer: Buffer.concat(chunks),
        contentType: res.ContentType || null,
      };
    } catch (e) {
      logger.error({
        msg: "Error descargando de staging",
        key,
        error: (e as Error).message,
      });
      return { buffer: null, contentType: null };
    }
  }

  private async uploadToS3(
    body: Buffer,
    key: string,
    contentType: string,
  ): Promise<boolean> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000", // 1 año de cache
        }),
      );
      return true;
    } catch (e) {
      logger.error({
        msg: "Error subiendo a S3",
        key,
        error: (e as Error).message,
      });
      return false;
    }
  }

  private async deleteFromStaging(key: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      );
    } catch (e) {
      logger.warn({
        msg: "No se pudo borrar del staging",
        key,
        error: (e as Error).message,
      });
    }
  }

  private async updateLegacyDb(
    image: ImageOptimizationMessage["image"],
    newUrl: string,
  ): Promise<boolean> {
    try {
      if (image.entityType !== "PRODUCT") {
        throw new Error(`EntityType no soportado: ${image.entityType}`);
      }
      const prisma = getAuroraDb();
      await prisma.$executeRawUnsafe(
        `UPDATE Product SET ${image.fieldName} = ? WHERE id = ?`,
        newUrl,
        image.entityId,
      );
      return true;
    } catch (e) {
      logger.error({
        msg: "Error actualizando BD legacy",
        entityId: image.entityId,
        error: (e as Error).message,
      });
      return false;
    }
  }

  private getExtension(keyOrUrl: string): string {
    try {
      const pathname = keyOrUrl.includes("://")
        ? new URL(keyOrUrl).pathname
        : keyOrUrl;
      const match = pathname.match(/\.(jpe?g|png|webp|gif)$/i);
      return match ? match[0].toLowerCase() : ".jpg";
    } catch {
      return ".jpg";
    }
  }

  /** Hash del buffer optimizado para evitar colisiones */
  private hashBuffer(buffer: Buffer): string {
    return createHash("md5").update(buffer).digest("hex").slice(0, 16);
  }

  /** Construye path {año}/{mes}/{dia} desde ISO string */
  private buildDatePath(iso: string): string {
    const d = new Date(iso);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }
}
