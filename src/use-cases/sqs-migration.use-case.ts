import { PrismaClient } from '@prisma/client';
import { IdempotencyService } from '../services/idempotency.service';
import { UserMigrationMessage, UserMigrationResponse } from '../types/sqs-migration.types';
import { getCatalogCache } from '../utils/catalog';
import { logger } from '../utils/logger';

export class SqsMigrationUseCase {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotencyService: IdempotencyService
  ) {}

  async execute(payload: UserMigrationMessage): Promise<UserMigrationResponse | void> {
    const { eventId, eventType } = payload;

    logger.info(`[SQS_MIGRATION] Procesando evento: ${eventId} | Tipo: ${eventType}`);

    // ⚠️ Solo aplicamos idempotencia para mutaciones (CREATE/UPDATE/DELETE)
    const isMutation = eventType !== 'GET_USER';
    let lockAcquired = false;

    if (isMutation) {
      lockAcquired = await this.idempotencyService.acquireLock(eventId);
      if (!lockAcquired) {
        logger.warn(`[SQS_MIGRATION] Evento omitido por idempotencia: ${eventId}`);
        return;
      }
    }

    try {
      let result: UserMigrationResponse | void = undefined;

      switch (eventType) {
        case 'CREATE_USER':
          await this.handleCreateUser(payload);
          break;
        case 'UPDATE_USER':
          await this.handleUpdateUser(payload);
          break;
        case 'DELETE_USER':
          await this.handleDeleteUser(payload);
          break;
        case 'GET_USER':
          result = await this.handleGetUser(payload);
          break;
        default:
          logger.warn(`[SQS_MIGRATION] Tipo de evento no soportado: ${eventType}`);
      }

      if (isMutation) {
        await this.idempotencyService.markAsProcessed(eventId);
      }
      
      logger.info(`[SQS_MIGRATION] Evento completado con éxito: ${eventId || (result|| {}).eventId }`);
      return result;
    } catch (error) {
      logger.error(`[SQS_MIGRATION] Error procesando evento ${eventId}:`, error);
      if (isMutation && lockAcquired) {
        await this.idempotencyService.releaseLock(eventId);
      }
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

    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub) userConditions.push({ cognito_sub: userData.cognitoSub });
    if (userData.email) userConditions.push({ email: userData.email });

    if (userConditions.length === 0) {
      throw new Error('[UPDATE_USER] Se requiere cognitoSub o email para identificar al usuario.');
    }

    await this.prisma.$transaction(async (tx) => {
      let user = await tx.users.findFirst({
        where: { OR: userConditions },
        include: { person: true },
      });

      if (!user) {
        throw new Error(`[UPDATE_USER] Usuario no encontrado para cognitoSub: ${userData.cognitoSub} o email: ${userData.email}`);
      }

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

      logger.info(`[UPDATE_USER] Actualizando datos de usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: {
          ...(userData.isActive !== undefined && { is_active: userData.isActive }),
          ...(userData.lastLoginAt && { last_login_at: new Date(userData.lastLoginAt) }),
        },
      });

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
  // 3. DELETE_USER: StoreMemberships -> Users -> Persons
  // =========================================================================
  private async handleDeleteUser(payload: UserMigrationMessage): Promise<void> {
    const { user: userData } = payload;

    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub) userConditions.push({ cognito_sub: userData.cognitoSub });
    if (userData.email) userConditions.push({ email: userData.email });

    if (userConditions.length === 0) {
      logger.warn('[DELETE_USER] No se proporcionó cognitoSub ni email para eliminar.');
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.users.findFirst({
        where: { OR: userConditions },
        select: { id: true, person_id: true, is_active: true },
      });

      if (!user) {
        logger.warn(`[DELETE_USER] Usuario no encontrado para desactivar (email: ${userData.email}, cognitoSub: ${userData.cognitoSub}).`);
        return;
      }

      logger.info(`[DELETE_USER] Desactivando membresías del usuario ID: ${user.id}`);
      await tx.store_memberships.updateMany({
        where: { user_id: user.id, is_active: true },
        data: { is_active: false },
      });

      logger.info(`[DELETE_USER] Desactivando usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: { is_active: false },
      });
    });
  }

  // =========================================================================
  // 4. GET_USER: GET DATA DEL USUARIO
  // =========================================================================
  private async handleGetUser(payload: UserMigrationMessage): Promise<UserMigrationResponse> {
    const { eventId, user: userData, person: personData, membership: membershipData } = payload;
    
    logger.info(`[GET_USER] Consultando/Creando usuario: ${userData.email || userData.cognitoSub}`);

    const userConditions = [];
    if (userData.email) userConditions.push({ email: userData.email });
    if (userData.cognitoSub) userConditions.push({ cognito_sub: userData.cognitoSub });

    if (userConditions.length === 0) {
      throw new Error('[GET_USER] Se requiere email o cognitoSub');
    }

    // 1. Intentar buscar el usuario
    let existingUser = await this.prisma.users.findFirst({
      where: { OR: userConditions },
      include: {
        person: true,
        memberships: {
          where: { is_active: true },
          include: {
            store: { select: { id: true, name: true, business_name: true, ruc: true, logo_url: true, is_active: true } },
            role: { select: { id: true, name: true, description: true } }
          }
        }
      }
    });

    // 2. Si NO existe, procedemos a crearlo (Upsert logic)
    if (!existingUser) {
      logger.warn(`[GET_USER] Usuario no encontrado. Procediendo a crear registro on-the-fly.`);
      
      const catalog = await getCatalogCache();

      await this.prisma.$transaction(async (tx) => {
      
        const docTypeId = 'ef4128c2-95ce-11f1-b5bb-0efefcff1da7';
        const ubigeoId = null;
        
        const person = await tx.persons.create({
          data: {
            legacy_person_id: personData.legacyPersonId ? BigInt(personData.legacyPersonId) : null,
            first_name: personData.firstName || 'Unknown',
            last_name: personData.lastName || 'Unknown',
            document_type_id: docTypeId || null,
            document_number: personData.documentNumber,
            ubigeo_id: ubigeoId || null,
            address: personData.address || null,
          },
        });
      
        // B. Crear Usuario
        const newUser = await tx.users.create({
          data: {
            person_id: person.id,
            email: userData.email,
            cognito_sub: userData.cognitoSub,
            is_active: userData.isActive ?? true,
            last_login_at: userData.lastLoginAt ? new Date(userData.lastLoginAt) : null,
          },
        });

        // C. Crear Membresía (si viene en el payload)
        if (membershipData) {
          const storeId = catalog.stores[String(membershipData.storeLegacyId)];
          const roleId = catalog.roles[membershipData.role];

          if (storeId && roleId) {
            await tx.store_memberships.create({
              data: {
                user_id: newUser.id,
                store_id: storeId,
                role_id: roleId,
                is_owner: membershipData.isOwnerStore ?? false,
                is_active: membershipData.isActive ?? true,
              },
            });
          }
        }
      });

      // Recargamos la data completa después de la transacción para retornarla consistente
      existingUser = await this.prisma.users.findFirst({
        where: { OR: userConditions },
        include: {
          person: true,
          memberships: {
            where: { is_active: true },
            include: {
              store: { select: { id: true, name: true, business_name: true, ruc: true, logo_url: true, is_active: true } },
              role: { select: { id: true, name: true, description: true } }
            }
          }
        }
      });
    }

    // 3. Retornar la data (ya sea la encontrada originalmente o la recién creada)
    if (!existingUser) {
       // Esto técnicamente no debería pasar si la creación fue exitosa, pero por seguridad
       return { eventId, status: 'NOT_FOUND' };
    }

    const person = existingUser.person;
    
    return {
      eventId,
      status: 'SUCCESS',
      data: {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          cognitoSub: existingUser.cognito_sub || '',
          isActive: existingUser.is_active ?? true,
          lastLoginAt: existingUser.last_login_at || undefined,
        },
        person: person ? {
          firstName: person.first_name,
          lastName: person.last_name,
          fullName: [person.first_name, person.last_name].filter(Boolean).join(' '),
          documentNumber: person.document_number || null,
          birthDate: person.birth_date || undefined,
          address: person.address || undefined,
        } : null,
        memberships: (existingUser.memberships || []).map((m: any) => ({
          id: m.id,
          store: {
            id: m.store?.id || '',
            name: m.store?.name || '',
            businessName: m.store?.business_name || undefined,
            ruc: m.store?.ruc || undefined,
            logoUrl: m.store?.logo_url || undefined,
            isActive: m.store?.is_active ?? true,
          },
          role: {
            id: m.role?.id || '',
            name: m.role?.name || '',
            description: m.role?.description || undefined,
          },
          isOwner: m.is_owner,
          employeeCode: m.employee_code || undefined,
          hireDate: m.hire_date || undefined,
          isActive: m.is_active ?? true,
        })),
      }
    };
  }
}