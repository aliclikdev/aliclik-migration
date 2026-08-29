// src/types/image-optimization.types.ts

export type ImageEntityType = "PRODUCT"; // Extensible a 'USER', 'STORE', etc.

export interface ImagePayload {
  entityType: ImageEntityType;
  entityId: number;
  stagingS3Key: string; // ej: "staging/2026/08/30/abc123.jpg"
  fieldName: string; // ej: "urlImage"
  uploadedAt?: string; // ISO timestamp
}

export interface ImageOptimizationMessage {
  eventId: string;
  eventType: "IMAGE_UPLOADED" | "IMAGE_UPDATED";
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  image: ImagePayload;
}
