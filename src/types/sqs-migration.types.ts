export type MigrationEventType =
  | 'CREATE_USER'
  | 'UPDATE_USER'
  | 'DELETE_USER'
  | 'GET_USER';

export interface UserMigrationMessage {
  eventId: string;
  eventType: MigrationEventType;
  timestamp: string;
  sourceSystem: 'ALICLIK_LEGACY_HEROKU';
  replyToQueueUrl?: string;
  person: {
    legacyPersonId?: number;
    firstName: string;
    lastName: string;
    documentType?: 'DNI' | 'RUC' | 'CE' | 'PASSPORT';
    documentNumber: string;
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
  membership?: {
    storeLegacyId: number;
    role: 'ADMIN_STORE' | 'SELLER' | 'MOTORIZED' | 'LIQUIDATOR' | 'MASTER' | 'SUPER_MASTER';
    isOwnerStore?: boolean;
    warehouseLegacyId?: number;
    isActive?: boolean;
  };
  settings?: {
    companyPrefix: string;
    spreadsheetOrder?: Record<string, any>;
  };
}

export interface UserMigrationResponse{
  eventId: string;
  status: 'SUCCESS' | 'ALREADY_PROCESSED' | 'NOT_FOUND';
  data?: {
    user: {
      id: string;
      email: string;
      cognitoSub: string;
      isActive: boolean;
      phone?: string;
      lastLoginAt?: Date;
    };
    person: {
      firstName: string | null | undefined;
      fullName: string | null | undefined;
      lastName: string | null | undefined;
      documentNumber: string | null | undefined;
      address?: string | null | undefined;
      birthDate: Date | null | undefined;
    } | null | undefined;
    memberships: Array<{
      storeId: string | null | undefined;
      roleId: string | null | undefined;
      isActive: boolean;
    }> | null | undefined;
  };
}
