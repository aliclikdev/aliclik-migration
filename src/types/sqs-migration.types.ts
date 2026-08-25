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

// Estructura anidada para la tienda
export interface StoreWithDetails {
  id: string;
  name: string;
  legacyStoreId?: number;
  businessName?: string;
  ruc?: string;
  logoUrl?: string | null | undefined;
  isActive: boolean;

  // Configuración agrupada
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

  // Membresía del usuario en esta tienda específica
  membership?: {
    roleId: string;
    roleName: string;
    isOwner: boolean;
    employeeCode?: string;
    hireDate?: Date;
    isActive: boolean;
  };
}

export interface UserMigrationMessage {
  eventId: string;
  eventType: MigrationEventType;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;

  person: {
    legacyPersonId?: number;
    firstName: string;
    lastName: string;
    documentType?: "DNI" | "RUC" | "CE" | "PASSPORT";
    birthDate?: Date | null | undefined;
    documentNumber?: string;
    ubigeoCode?: string;
    address?: string;
  };

  user: {
    legacyUserId?: number;
    email: string;
    cognitoSub: string;
    isActive: boolean;
    lastLoginAt?: string;
  };

  // La tienda ahora contiene sus propios detalles, settings y membresía
  store: StoreWithDetails;

  termsAcceptance?:
    | {
        termsId: string;
        version: number;
        ipAddress?: string;
        userAgent?: string;
        comment?: string;
      }
    | null
    | undefined;
}

export interface StoreMembershipDetails {
  id: string;
  store: {
    id: string;
    name: string;
    businessName?: string;
    ruc?: string;
    logoUrl?: string;
    isActive: boolean;
  };
  role: {
    id: string;
    name: string;
    description?: string;
  };
  isOwner: boolean;
  employeeCode?: string;
  hireDate?: Date;
  isActive: boolean;
}

export interface UserMigrationResponse {
  eventId: string;
  status: "SUCCESS" | "ALREADY_PROCESSED" | "NOT_FOUND";
  data?: {
    user: {
      id: string;
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

    memberships: StoreMembershipDetails[];

    termsStatus?:
      | {
          hasActiveTerms: boolean;
          termsId: string | null;
          currentVersion: number | null;
          hasAccepted: boolean;
          acceptedVersion: number | null;
        }
      | null
      | undefined;
  };
}
//todo: productos
export type ProductMigrationEventType = "CREATE_PRODUCT";

export interface ProductCategoryPayload {
  id?: string;
  name?: string;
  parentId?: string | null;
  isActive?: boolean;
}

export interface ProductCatalogPayload {
  id?: string;
  name?: string;
  isPublic?: boolean;
}

export interface ProductImagePayload {
  url: string;
  title?: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
  imageType?: string; // default 'PRODUCT'
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
  isActive?: boolean;
}

export interface SkuPayload {
  legacySkuId?: number;
  skuCode: string;
  ean?: string;
  regularPrice: number;
  salesPrice: number;
  purchasePrice: number;
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
  warehouseSkus?: WarehouseSkuPayload[];
}

export interface WarehouseSkuPayload {
  legacyWarehouseSkuId?: number;
  legacyWarehouseId: number; // Crucial para hacer el JOIN con la tabla `warehouses`
  stockPhysical?: number;
  stockVirtual?: number;
  stockReserved?: number;
}

export interface ProductPayload {
  legacyProductId?: number;
  storeLegacyId: number;
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
  statusCode?: string; // code de product_statuses (ej: 'ACTIVE')
  isActive?: boolean;
}

export interface ProductMigrationMessage {
  eventId: string;
  eventType: ProductMigrationEventType;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  product: ProductPayload;
  skus: SkuPayload[];
  images?: ProductImagePayload[];
}

// ============================================
// VARIANTES (Nivel 2)
// ============================================
export interface VariantOptionPayload {
  legacyOptionId?: number;
  name: string;
}

export interface VariantPayload {
  legacyVariantId?: number;
  legacyProductId: number;
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
// SKUS (Nivel 3)
// ============================================
export interface SkuVariantOptionRef {
  legacyOptionId?: number;
  variantOptionId?: string; // UUID del nuevo sistema (si ya existe)
}

export interface SkuMigrationPayload {
  legacySkuId?: number;
  legacyProductId: number;
  skuCode: string;
  ean?: string;
  regularPrice?: number;
  salesPrice?: number;
  purchasePrice?: number;
  stockMin?: number;
  stockMax?: number;
  variantOptions?: SkuVariantOptionRef[];
}

export interface SkuMigrationMessage {
  eventId: string;
  eventType: string;
  timestamp: string;
  sourceSystem: "ALICLIK_LEGACY_HEROKU";
  replyToQueueUrl?: string;
  sku: SkuMigrationPayload;
}

// Tipo unión que consume el entrypoint SQS y el use case.
export type SqsMigrationMessage =
  | UserMigrationMessage
  | ProductMigrationMessage
  | ProductVariantMigrationMessage
  | SkuMigrationMessage;
