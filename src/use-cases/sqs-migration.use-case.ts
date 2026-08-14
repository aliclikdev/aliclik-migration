import { PrismaClient } from '@prisma/client';
import { IdempotencyService } from '../services/idempotency.service';
import { UserMigrationMessage } from '../types/sqs-migration.types';
import { getCatalogCache } from '../utils/catalog';
import { logger } from '../utils/logger';

export class SqsMigrationUseCase {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotencyService: IdempotencyService
  ) {}

  async execute(payload: UserMigrationMessage): Promise<void> {
    const { eventId, eventType } = payload;

    logger.info(`[SQS_MIGRATION] Procesando evento: ${eventId} | Tipo: ${eventType}`);

    // Guard de Idempotencia
    const lockAcquired = await this.idempotencyService.acquireLock(eventId);
    if (!lockAcquired) {
      logger.warn(`[SQS_MIGRATION] Evento omitido por idempotencia (ya procesado o en progreso): ${eventId}`);
      return;
    }

    try {
      switch (eventType) {
        case 'CREATE_USER':
          await this.handleCreateUser(payload);
          break;
        case 'UPDATE_USER':
          await this.handleUpdateUser(payload);
          break;
        case 'DELETE_USER' as any:
          await this.handleDeleteUser(payload);
          break;
        default:
          logger.warn(`[SQS_MIGRATION] Tipo de evento no soportado: ${eventType}`);
      }

      await this.idempotencyService.markAsProcessed(eventId);
      logger.info(`[SQS_MIGRATION] Evento completado con éxito: ${eventId}`);
    } catch (error) {
      logger.error(`[SQS_MIGRATION] Error procesando evento ${eventId}:`, error);
      await this.idempotencyService.releaseLock(eventId);
      throw error;
    }
  }

  // =========================================================================
  // 1. CREATE_USER: Persons -> Users -> StoreMemberships
  // =========================================================================
  private async handleCreateUser(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const { person: personData, user: userData, membership: membershipData } = payload;

    // Mapeo de Catálogos
    const docTypeId = personData.documentType ? catalog.docTypes[personData.documentType] : undefined;
    const ubigeoId = personData.ubigeoCode ? catalog.ubigeos[personData.ubigeoCode] : undefined;

    await this.prisma.$transaction(async (tx) => {
      // 1.1 Crear o buscar Persona (por document_number)
      let person = await tx.persons.findUnique({
        where: { document_number: personData.documentNumber },
      });

      if (!person) {
        logger.info(`[CREATE_USER] Creando registro de persona: ${personData.documentNumber}`);
        person = await tx.persons.create({
          data: {
            legacy_person_id: personData.legacyPersonId ? BigInt(personData.legacyPersonId) : null,
            first_name: personData.firstName,
            last_name: personData.lastName,
            document_type_id: docTypeId || null,
            document_number: personData.documentNumber,
            ubigeo_id: ubigeoId || null,
            address: personData.address || null,
          },
        });
      }

      // 1.2 Crear Usuario
      logger.info(`[CREATE_USER] Creando usuario: ${userData.email}`);
      const createdUser = await tx.users.create({
        data: {
          person_id: person.id,
          email: userData.email,
          cognito_sub: userData.cognitoSub,
          is_active: userData.isActive ?? true,
          last_login_at: userData.lastLoginAt ? new Date(userData.lastLoginAt) : null,
        },
      });

      // 1.3 Crear Membresía
      if (membershipData) {
        const storeId = catalog.stores[String(membershipData.storeLegacyId)];
        const roleId = catalog.roles[membershipData.role];

        if (!storeId) {
          throw new Error(`Store legacy ID ${membershipData.storeLegacyId} no encontrado en catálogo.`);
        }
        if (!roleId) {
          throw new Error(`Rol ${membershipData.role} no encontrado en catálogo.`);
        }

        logger.info(`[CREATE_USER] Creando membresía para tienda ID: ${storeId}`);
        await tx.store_memberships.create({
          data: {
            user_id: createdUser.id,
            store_id: storeId,
            role_id: roleId,
            is_owner: membershipData.isOwnerStore ?? false,
            is_active: membershipData.isActive ?? true,
          },
        });
      }
    });
  }

  // =========================================================================
  // 2. UPDATE_USER: Persons -> Users -> StoreMemberships
  // =========================================================================
  private async handleUpdateUser(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const { person: personData, user: userData, membership: membershipData } = payload;

    await this.prisma.$transaction(async (tx) => {
      // Búsqueda del usuario por cognito_sub o email
      let user = await tx.users.findFirst({
        where: {
          OR: [
            { cognito_sub: userData.cognitoSub },
            { email: userData.email },
          ],
        },
        include: { person: true },
      });

      if (!user) {
        throw new Error(`[UPDATE_USER] Usuario no encontrado para cognitoSub: ${userData.cognitoSub} o email: ${userData.email}`);
      }

      // 2.1 Actualizar Persona si está presente en el payload
      if (personData && user.person_id) {
        const docTypeId = personData.documentType ? catalog.docTypes[personData.documentType] : undefined;
        const ubigeoId = personData.ubigeoCode ? catalog.ubigeos[personData.ubigeoCode] : undefined;

        logger.info(`[UPDATE_USER] Actualizando persona ID: ${user.person_id}`);
        await tx.persons.update({
          where: { id: user.person_id },
          data: {
            ...(personData.firstName && { first_name: personData.firstName }),
            ...(personData.lastName && { last_name: personData.lastName }),
            ...(docTypeId && { document_type_id: docTypeId }),
            ...(personData.documentNumber && { document_number: personData.documentNumber }),
            ...(ubigeoId !== undefined && { ubigeo_id: ubigeoId }),
            ...(personData.address !== undefined && { address: personData.address }),
          },
        });
      }

      // 2.2 Actualizar Usuario
      logger.info(`[UPDATE_USER] Actualizando datos de usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: {
          ...(userData.email && { email: userData.email }),
          ...(userData.cognitoSub && { cognito_sub: userData.cognitoSub }),
          ...(userData.isActive !== undefined && { is_active: userData.isActive }),
          ...(userData.lastLoginAt && { last_login_at: new Date(userData.lastLoginAt) }),
        },
      });

      // 2.3 Sincronizar / Actualizar Membresías
      if (membershipData) {
        const storeId = catalog.stores[String(membershipData.storeLegacyId)];
        const roleId = catalog.roles[membershipData.role];

        if (storeId && roleId) {
          logger.info(`[UPDATE_USER] Actualizando/Creando membresía de tienda ID: ${storeId}`);
          await tx.store_memberships.upsert({
            where: {
              idx_user_store_unique: {
                user_id: user.id,
                store_id: storeId,
              },
            },
            create: {
              user_id: user.id,
              store_id: storeId,
              role_id: roleId,
              is_owner: membershipData.isOwnerStore ?? false,
              is_active: membershipData.isActive ?? true,
            },
            update: {
              role_id: roleId,
              ...(membershipData.isOwnerStore !== undefined && { is_owner: membershipData.isOwnerStore }),
              ...(membershipData.isActive !== undefined && { is_active: membershipData.isActive }),
            },
          });
        }
      }
    });
  }

  // =========================================================================
  // 3. DELETE_USER: StoreMemberships -> Users -> Persons (Orden por FK)
  // =========================================================================
  private async handleDeleteUser(payload: UserMigrationMessage): Promise<void> {
    const { user: userData } = payload;

    await this.prisma.$transaction(async (tx) => {
      // Buscar usuario a desactivar
      const user = await tx.users.findFirst({
        where: {
          OR: [
            ...(userData.cognitoSub ? [{ cognito_sub: userData.cognitoSub }] : []),
            ...(userData.email ? [{ email: userData.email }] : []),
          ],
        },
        select: { id: true, person_id: true, is_active: true },
      });

      if (!user) {
        logger.warn(`[DELETE_USER] Usuario no encontrado para desactivar (email: ${userData.email}, cognitoSub: ${userData.cognitoSub}).`);
        return;
      }

      // 3.1 Desactivar Membresías activas del usuario
      logger.info(`[DELETE_USER] Desactivando membresías del usuario ID: ${user.id}`);
      await tx.store_memberships.updateMany({
        where: { user_id: user.id, is_active: true },
        data: { is_active: false },
      });

      // 3.2 Desactivar el Usuario
      logger.info(`[DELETE_USER] Desactivando usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: { is_active: false },
      });

      // Nota: Mantener el registro de 'persons' intacto preserva la identidad 
      // e historial legal de la persona en el sistema.
    });
  }
}