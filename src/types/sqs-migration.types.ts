// src/types/sqs-migration.types.ts

// ============================================
// 1. TIPOS DE EVENTOS
// ============================================

export type MigrationEventType =
  | "CREATE_USER"
  | "UPDATE_USER"
  | "DELETE_USER"
  | "GET_USER"
  | "ACCEPT_TERMS"
  | "STORE_SETTINGS"
  | "CREATE_PRODUCT"
  | "CREATE_PRODUCT_VARIANT"
  | "CREATE_SKU";

// ============================================
// 2. STORE Y MEMBRESÍAS (con bigint)
// ============================================

export interface StoreWithDetails {
  id: bigint; // ✅ CORREGIDO: string → bigint
  name: string;
  legacyStoreId?: number; // ✅ Este puede ser number porque viene del legacy
  businessName?: string;
  ruc?: string;
  logoUrl?: string | null | undefined;
  isActive: boolean;
  settings?: {
    companyPrefix?: string;
    currencyCode?: string;
    timezone?: string;
    supportPhone?: string | null | undefined;
    config?: object | null | null;
    supportEmail?: string;
    isEmailTransferVerified?: boolean;
    accountVerified?: boolean;
  };
  membership?: {
    roleId: bigint; // ✅ CORREGIDO: string → bigint
    roleName: string;
    isOwner: boolean;
    employeeCode?: string;
    hireDate?: Date;
    isActive: boolean;
  };
}

// ============================================
// 3. USER MIGRATION MESSAGE
// ============================================

export interface UserMigrationMessage {
  eventId: string;
  eventType: MigrationEventType;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  person: {
    legacyPersonId?: number; // ✅ Este es el ID del legacy (number)
    firstName: string;
    lastName: string;
    documentType?: "DNI" | "RUC" | "CE" | "PASSPORT";
    birthDate?: Date | null | undefined;
    documentNumber?: string;
    ubigeoCode?: string;
    address?: string;
  };
  user: {
    legacyUserId?: number; // ✅ Este es el ID del legacy (number)
    email: string;
    cognitoSub: string;
    isActive: boolean;
    lastLoginAt?: string;
  };
  store: StoreWithDetails;
  termsAcceptance?:
    | {
        termsId: bigint; // ✅ CORREGIDO: string → bigint
        version: number;
        ipAddress?: string;
        userAgent?: string;
        comment?: string;
      }
    | null
    | undefined;
}

// ============================================
// 4. STORE MEMBERSHIP DETAILS
// ============================================

export interface StoreMembershipDetails {
  id: bigint; // ✅ CORREGIDO: string → bigint
  store: {
    id: bigint; // ✅ CORREGIDO: string → bigint
    name: string;
    businessName?: string;
    ruc?: string;
    logoUrl?: string;
    isActive: boolean;
  };
  role: {
    id: bigint; // ✅ CORREGIDO: string → bigint
    name: string;
    description?: string;
  };
  isOwner: boolean;
  employeeCode?: string;
  hireDate?: Date;
  isActive: boolean;
}

// ============================================
// 5. USER MIGRATION RESPONSE
// ============================================

export interface UserMigrationResponse {
  eventId: string;
  status: "SUCCESS" | "ALREADY_PROCESSED" | "NOT_FOUND";
  data?: {
    user: {
      id: bigint; // ✅ CORREGIDO: string → bigint
      email: string;
      cognitoSub: string;
      isActive: boolean;
      phone?: string;
      lastLoginAt?: Date;
    };
    person:
      | {
          firstName: string | null | undefined;
          fullName: string | null | undefined;
          lastName: string | null | undefined;
          documentNumber: string | null | undefined;
          address?: string | null | undefined;
          birthDate: Date | null | undefined;
        }
      | null
      | undefined;
    memberships: StoreMembershipDetails[]; // ✅ Ahora usa bigint
    termsStatus?:
      | {
          hasActiveTerms: boolean;
          termsId: bigint | null; // ✅ CORREGIDO: string → bigint
          currentVersion: number | null;
          hasAccepted: boolean;
          acceptedVersion: number | null;
        }
      | null
      | undefined;
  };
}

// ============================================
// 6. PRODUCT TYPES
// ============================================

export type ProductMigrationEventType = "CREATE_PRODUCT";

export interface ProductCategoryPayload {
  id?: bigint | null; // ✅ CORREGIDO: string → bigint | null
  name?: string;
  parentId?: bigint | null; // ✅ CORREGIDO: string → bigint | null
  isActive?: boolean;
}

export interface ProductCatalogPayload {
  id?: bigint | null; // ✅ CORREGIDO: string → bigint | null
  name?: string;
  isPublic?: boolean;
}

export interface ProductImagePayload {
  url: string;
  title?: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
  imageType?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
  isActive?: boolean;
}

export interface ProductPayload {
  legacyProductId?: number; // ✅ Este es el ID del legacy (number)
  storeLegacyId?: number; // ✅ Este es el ID del legacy (number)
  storeId?: bigint | null; // ✅ CORREGIDO: string → bigint | null
  category?: ProductCategoryPayload | null;
  catalog?: ProductCatalogPayload | null;
  name: string;
  shortDescription?: string;
  largeDescription?: string;
  description?: string;
  urlImage?: string;
  urlReference?: string;
  isProductGlobal?: boolean;
  salePriceDrop?: number;
  priceDropCrate?: number;
  priceDropDozen?: number;
  retailPriceSuggested?: number;
  unitsCrate?: number;
  isNovelty?: boolean;
  isLargeVolume?: boolean;
  isValidate?: boolean;
  isRegisteredProduct?: boolean;
  statusCode?: string;
  isActive?: boolean;
}

export interface ProductMigrationMessage {
  eventId: string;
  eventType: ProductMigrationEventType;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  product: ProductPayload;
  images?: ProductImagePayload[];
}

// ============================================
// 7. PRODUCT VARIANT TYPES
// ============================================

export interface VariantOptionPayload {
  legacyOptionId?: number; // ✅ Este es el ID del legacy (number)
  name: string;
}

export interface VariantPayload {
  legacyVariantId?: number; // ✅ Este es el ID del legacy (number)
  legacyProductId: number; // ✅ Este es el ID del legacy (number)
  name: string;
  options?: VariantOptionPayload[];
}

export interface ProductVariantMigrationMessage {
  eventId: string;
  eventType: string;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  variant: VariantPayload;
}

// ============================================
// 8. SKU TYPES
// ============================================

export interface SkuVariantOptionRef {
  legacyOptionId?: number; // ✅ number (ID del legacy)
  variantOptionId?: bigint; // ✅ CORREGIDO: string → bigint
  name?: string;
}

export interface SkuMigrationPayload {
  legacySkuId?: number; // ✅ number (ID del legacy)
  legacyProductId: number; // ✅ number (ID del legacy)
  skuCode: string;
  ean?: string;
  regularPrice?: number;
  salesPrice?: number;
  purchasePrice?: number;
  dropPrice?: number;
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
  stockMin?: number;
  stockMax?: number;
  trackStock?: boolean;
  allowBackorder?: boolean;
  isActive?: boolean;
  warehouseStocks?: Array<{
    legacyWarehouseId: number; // ✅ number (ID del legacy)
    warehouseId?: bigint; // ✅ CORREGIDO: string → bigint
    warehouseName?: string;
    stockPhysical?: number;
    stockVirtual?: number;
    stockReserved?: number;
    legacyWarehouseSkuId?: number;
  }>;
  variantOptions?: Array<{
    legacyOptionId?: number;
    variantOptionId?: bigint; // ✅ CORREGIDO: string → bigint
    name?: string;
  }>;
}

export interface SkuMigrationMessage {
  eventId: string;
  eventType: string;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  sku: SkuMigrationPayload;
}

// ============================================
// 9. UNION TYPE
// ============================================

export type SqsMigrationMessage =
  | UserMigrationMessage
  | ProductMigrationMessage
  | ProductVariantMigrationMessage
  | SkuMigrationMessage;
