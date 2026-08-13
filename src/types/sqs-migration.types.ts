export type MigrationEventType =
  | 'CREATE_USER'
  | 'UPDATE_USER';

export interface UserMigrationMessage {
  eventId: string;
  eventType: MigrationEventType;
  timestamp: string;
  sourceSystem: 'ALICLIK_LEGACY_HEROKU';
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
    phone?: string;
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

