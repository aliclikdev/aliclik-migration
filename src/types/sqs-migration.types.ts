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
export interface StoreWithDetails {
  id: string;
  name: string;
  legacyStoreId?: number;
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
  imageType?: string;
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
  legacyWarehouseId: number;
  warehouseName?: string;
  stockPhysical?: number;
  stockVirtual?: number;
  stockReserved?: number;
}
export interface ProductPayload {
  legacyProductId?: number;
  storeLegacyId?: number;
  storeId?: string;
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
export interface SkuVariantOptionRef {
  legacyOptionId?: number;
  variantOptionId?: string;
  name?: string;
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
  isActive?: boolean;
  warehouseStocks?: Array<{
    legacyWarehouseId?: number;
    warehouseId?: string;
    warehouseName?: string;
    stockPhysical?: number;
    stockVirtual?: number;
    stockReserved?: number;
    legacyWarehouseSkuId?: number;
  }>;
  variantOptions?: Array<{
    legacyOptionId?: number;
    variantOptionId?: string;
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
export type SqsMigrationMessage =
  | UserMigrationMessage
  | ProductMigrationMessage
  | ProductVariantMigrationMessage
  | SkuMigrationMessage;
