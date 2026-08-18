export type MigrationEventType =
  | "CREATE_USER"
  | "UPDATE_USER"
  | "DELETE_USER"
  | "GET_USER"
  | "ACCEPT_TERMS"
  | "STORE_SETTINGS";

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
    defaultShippingCost?: number;
    motorizedWorkloadLimit?: number;
    supportPhone?: string | null | undefined;
    supportEmail?: string;
    isEmailTransferVerified?: boolean;
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
    documentNumber: string | null | undefined;
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

    // Respuesta también refleja la nueva estructura anidada
    store: StoreWithDetails | null | undefined;

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
