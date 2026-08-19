import { PrismaClient } from "@prisma/client";
import { IdempotencyService } from "../services/idempotency.service";
import {
  StoreWithDetails,
  UserMigrationMessage,
  UserMigrationResponse,
} from "../types/sqs-migration.types";
import { getCatalogCache } from "../utils/catalog";
import { logger } from "../utils/logger";

export class SqsMigrationUseCase {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  private buildStoreSettingsData(
    settings: NonNullable<StoreWithDetails["settings"]>,
  ) {
    return {
      company_prefix: settings.companyPrefix,
      currency_code: settings.currencyCode,
      timezone: settings.timezone,
      default_shipping_cost: settings.defaultShippingCost,
      motorized_workload_limit: 0,
      support_phone: settings.supportPhone,
      support_email: settings.supportEmail,
      is_email_transfer_verified: settings.isEmailTransferVerified,
    };
  }

  async execute(
    payload: UserMigrationMessage,
  ): Promise<UserMigrationResponse | void> {
    const { eventId, eventType } = payload;

    logger.info(
      `[SQS_MIGRATION] Procesando evento: ${eventId} | Tipo: ${eventType}`,
    );

    // ⚠️ Solo aplicamos idempotencia para mutaciones (CREATE/UPDATE/DELETE)
    const isMutation = [
      "CREATE_USER",
      "UPDATE_USER",
      "DELETE_USER",
      "ACCEPT_TERMS",
      "STORE_SETTINGS",
    ].includes(eventType);
    let lockAcquired = false;

    if (isMutation) {
      lockAcquired = await this.idempotencyService.acquireLock(eventId);
      if (!lockAcquired) {
        logger.warn(
          `[SQS_MIGRATION] Evento omitido por idempotencia: ${eventId}`,
        );
        return;
      }
    }

    try {
      let result: UserMigrationResponse | void = undefined;

      switch (eventType) {
        case "CREATE_USER":
          await this.handleCreateUser(payload);
          break;
        case "UPDATE_USER":
          await this.handleUpdateUser(payload);
          break;
        case "DELETE_USER":
          await this.handleDeleteUser(payload);
          break;
        case "GET_USER":
          result = await this.handleGetUser(payload);
          break;
        case "STORE_SETTINGS": // <-- Nuevo caso
          await this.handleStoreSettings(payload);
          break;
        default:
          logger.warn(
            `[SQS_MIGRATION] Tipo de evento no soportado: ${eventType}`,
          );
      }

      if (isMutation) {
        await this.idempotencyService.markAsProcessed(eventId);
      }

      logger.info(
        `[SQS_MIGRATION] Evento completado con éxito: ${eventId || (result || {}).eventId}`,
      );
      return result;
    } catch (error) {
      logger.error(
        `[SQS_MIGRATION] Error procesando evento ${eventId}:`,
        error,
      );
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
    const {
      person: personData,
      user: userData,
      store,
      store: { membership } = {},
    } = payload;

    const isExplicitCreate = payload.eventType === "CREATE_USER";

    if (isExplicitCreate && !personData.documentNumber) {
      throw new Error(
        `[CREATE_USER] Se requiere documentNumber para crear un usuario nuevo (email: ${userData.email}).`,
      );
    }

    if (!personData.documentNumber && !personData.legacyPersonId) {
      throw new Error(
        `[CREATE_USER] Se requiere documentNumber o legacyPersonId para identificar a la persona (email: ${userData.email}).`,
      );
    }

    // Mapeo de Catálogos básicos
    const docTypeId = personData.documentType
      ? catalog.docTypes[personData.documentType]
      : undefined;
    const ubigeoId = personData.ubigeoCode
      ? catalog.ubigeos[personData.ubigeoCode]
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      // --- PASO A: Persona ---
      let person = personData.documentNumber
        ? await tx.persons.findUnique({
            where: { document_number: personData.documentNumber },
          })
        : await tx.persons.findFirst({
            where: { legacy_person_id: BigInt(personData.legacyPersonId!) },
          });

      if (!person) {
        logger.info(
          `[CREATE_USER] Creando persona: ${personData.documentNumber || `legacyPersonId=${personData.legacyPersonId}`}`,
        );
        person = await tx.persons.create({
          data: {
            legacy_person_id: personData.legacyPersonId
              ? BigInt(personData.legacyPersonId)
              : null,
            first_name: personData.firstName,
            last_name: personData.lastName,
            document_type_id: docTypeId || null,
            document_number: personData.documentNumber || null,
            ubigeo_id: ubigeoId || null,
            address: personData.address || null,
          },
        });
      }

      // --- PASO B: Usuario (Sin cambios) ---
      logger.info(
        `[CREATE_USER] Creando/Actualizando usuario: ${userData.email}`,
      );
      const createdUser = await tx.users.upsert({
        where: { email: userData.email },
        update: {
          cognito_sub: userData.cognitoSub,
          is_active: userData.isActive ?? true,
          last_login_at: userData.lastLoginAt
            ? new Date(userData.lastLoginAt)
            : null,
        },
        create: {
          person_id: person.id,
          email: userData.email,
          cognito_sub: userData.cognitoSub,
          is_active: userData.isActive ?? true,
          last_login_at: userData.lastLoginAt
            ? new Date(userData.lastLoginAt)
            : null,
        },
      });

      // --- PASO C: Tienda + Membresía (Con Upsert de Tienda) ---
      if (membership) {
        // 1. Buscar tienda por legacy_id
        let storeFind = await tx.stores.findFirst({
          where: { legacy_store_id: BigInt(store?.legacyStoreId || 0) },
        });

        // 2. Si NO existe, CREARLA automáticamente
        let resolvedStoreId: string;
        if (!storeFind) {
          logger.warn(
            `[CREATE_USER] Tienda legacy ${store.legacyStoreId} no existe. Creándola...`,
          );

          // País por defecto: Perú, resuelto desde el catálogo real (ya no hardcodeado).
          // Nota: Idealmente deberías pasar countryCode en membershipData o inferirlo
          const defaultCountryId = catalog.countries["PER"];
          if (!defaultCountryId) {
            throw new Error(
              `[CREATE_USER] País por defecto "PER" no encontrado en catálogo.`,
            );
          }

          const storeCreate = await tx.stores.create({
            data: {
              legacy_store_id: BigInt(store.legacyStoreId || 0),
              name: `${store.name}`, // Nombre temporal
              business_name: store.businessName || null,
              ruc: store.ruc || null,
              logo_url: store.logoUrl || null,
              currency_code: "PEN", // Default seguro
              timezone: "America/Lima",
              is_active: store.isActive ?? true,
              country_id: defaultCountryId,
            },
          });
          resolvedStoreId = storeCreate.id;
        } else {
          resolvedStoreId = storeFind.id;
        }

        // 3. Resolver Rol
        const roleId = catalog.roles[membership.roleName];
        if (!roleId) {
          throw new Error(
            `Rol ${membership.roleName} no encontrado en catálogo.`,
          );
        }

        // 4. Crear/Actualizar Membresía
        logger.info(
          `[CREATE_USER] Vinculando usuario ${createdUser.id} a tienda ${resolvedStoreId}`,
        );
        await tx.store_memberships.upsert({
          where: {
            idx_user_store_unique: {
              user_id: createdUser.id,
              store_id: resolvedStoreId,
            },
          },
          create: {
            user_id: createdUser.id,
            store_id: resolvedStoreId,
            role_id: roleId,
            is_owner: membership.isOwner ?? false,
            is_active: membership.isActive ?? true,
          },
          update: {
            role_id: roleId,
            is_owner: membership.isOwner ?? undefined,
            is_active: membership.isActive ?? undefined,
          },
        });

        if (!isExplicitCreate && store.settings) {
          logger.info(
            `[GET_USER] Actualizando/Creando settings para store_id: ${resolvedStoreId} (migración perezosa)`,
          );

          const settingsData = this.buildStoreSettingsData(store.settings);

          await tx.store_settings.upsert({
            where: { store_id: resolvedStoreId },
            create: {
              store_id: resolvedStoreId,
              ...settingsData,
            },
            update: {
              ...settingsData,
            },
          });
        }
      }
    });
  }

  // =========================================================================
  // 2. UPDATE_USER: Persons -> Users -> StoreMemberships
  // =========================================================================
  private async handleUpdateUser(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const {
      person: personData,
      user: userData,
      store,
      store: { membership } = {},
    } = payload;

    // Construir condiciones de búsqueda dinámicas
    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub)
      userConditions.push({ cognito_sub: userData.cognitoSub });
    if (userData.email) userConditions.push({ email: userData.email });

    if (userConditions.length === 0) {
      throw new Error(
        "[UPDATE_USER] Se requiere cognitoSub o email para identificar al usuario.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Buscar usuario base
      let user = await tx.users.findFirst({
        where: { OR: userConditions },
        include: { person: true },
      });

      if (!user) {
        throw new Error(
          `[UPDATE_USER] Usuario no encontrado para cognitoSub: ${userData.cognitoSub} o email: ${userData.email}`,
        );
      }

      // 2. Actualizar Persona (si viene data de persona)
      if (personData && user.person_id) {
        const docTypeId = personData.documentType
          ? catalog.docTypes[personData.documentType]
          : undefined;

        const ubigeoId = personData.ubigeoCode
          ? catalog.ubigeos[personData.ubigeoCode]
          : undefined;

        logger.info(`[UPDATE_USER] Actualizando persona ID: ${user.person_id}`);

        await tx.persons.update({
          where: { id: user.person_id },
          data: {
            ...(personData.firstName !== undefined && {
              first_name: personData.firstName,
            }),
            ...(personData.lastName !== undefined && {
              last_name: personData.lastName,
            }),
            ...(docTypeId !== undefined && { document_type_id: docTypeId }),
            ...(personData.documentNumber !== undefined && {
              document_number: personData.documentNumber,
            }),
            ...(ubigeoId !== undefined && { ubigeo_id: ubigeoId }),
            ...(personData.address !== undefined && {
              address: personData.address,
            }),
            ...(personData.birthDate !== undefined && {
              birth_date: personData.birthDate
                ? new Date(personData.birthDate)
                : null,
            }),
          },
        });
      }

      // 3. Actualizar Usuario
      logger.info(`[UPDATE_USER] Actualizando datos de usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: {
          ...(userData.isActive !== undefined && {
            is_active: userData.isActive,
          }),
          ...(userData.lastLoginAt !== undefined && {
            last_login_at: userData.lastLoginAt
              ? new Date(userData.lastLoginAt)
              : null,
          }),
        },
      });

      // 4. Upsert Membresía (Crear si no existe, actualizar si existe)
      if (membership) {
        const storeId = catalog.stores[String(store.legacyStoreId)];
        const roleId = catalog.roles[membership.roleName];

        if (storeId && roleId) {
          logger.info(
            `[UPDATE_USER] Upserting membresía para tienda ID: ${storeId}`,
          );

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
              is_owner: membership.isOwner ?? false,
              is_active: membership.isActive ?? true,
              employee_code: membership.employeeCode || null,
              hire_date: membership.hireDate
                ? new Date(membership.hireDate)
                : null,
            },
            update: {
              role_id: roleId,
              ...(membership.isOwner !== undefined && {
                is_owner: membership.isOwner,
              }),
              ...(membership.isActive !== undefined && {
                is_active: membership.isActive,
              }),
              ...(membership.employeeCode !== undefined && {
                employee_code: membership.employeeCode,
              }),
              ...(membership.hireDate !== undefined && {
                hire_date: membership.hireDate
                  ? new Date(membership.hireDate)
                  : null,
              }),
            },
          });
        } else {
          logger.warn(
            `[UPDATE_USER] Catálogo incompleto para membresía. Store: ${store.legacyStoreId}, Role: ${membership.roleName}`,
          );
        }
      }
    });
  }

  // =========================================================================
  // 3. DELETE_USER: StoreMemberships -> Users -> Persons
  // =========================================================================
  private async handleDeleteUser(payload: UserMigrationMessage): Promise<void> {
    const { user: userData } = payload;

    // Construir condiciones de búsqueda dinámicas
    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub)
      userConditions.push({ cognito_sub: userData.cognitoSub });
    if (userData.email) userConditions.push({ email: userData.email });

    if (userConditions.length === 0) {
      logger.warn(
        "[DELETE_USER] No se proporcionó cognitoSub ni email para eliminar.",
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Buscar usuario con sus relaciones críticas
      const user = await tx.users.findFirst({
        where: { OR: userConditions },
        select: {
          id: true,
          person_id: true,
          is_active: true,
        },
      });

      if (!user) {
        logger.warn(
          `[DELETE_USER] Usuario no encontrado para desactivar ` +
            `(email: ${userData.email}, cognitoSub: ${userData.cognitoSub}).`,
        );
        return;
      }

      // Si ya está inactivo, evitamos operaciones innecesarias
      if (!user.is_active) {
        logger.info(
          `[DELETE_USER] Usuario ID ${user.id} ya se encuentra inactivo.`,
        );
        return;
      }

      // 2. Desactivar todas las membresías activas del usuario
      logger.info(
        `[DELETE_USER] Desactivando membresías del usuario ID: ${user.id}`,
      );
      await tx.store_memberships.updateMany({
        where: {
          user_id: user.id,
          is_active: true,
        },
        data: { is_active: false },
      });

      // 3. Desactivar el usuario
      logger.info(`[DELETE_USER] Desactivando usuario ID: ${user.id}`);
      await tx.users.update({
        where: { id: user.id },
        data: { is_active: false },
      });

      // 4. Opcional: Desactivar la persona si no tiene otros usuarios activos vinculados
      // Esto evita dejar personas huérfanas activas si el usuario era el único vínculo
      if (user.person_id) {
        const otherActiveUsers = await tx.users.count({
          where: {
            person_id: user.person_id,
            id: { not: user.id },
            is_active: true,
          },
        });

        if (otherActiveUsers === 0) {
          logger.info(
            `[DELETE_USER] Desactivando persona ID: ${user.person_id} (sin otros usuarios activos)`,
          );
          // Nota: En tu schema actual 'persons' no tiene campo is_active.
          // Si deseas mantener historial, considera agregarlo o simplemente dejar la persona como está.
          // Por ahora solo logueamos la acción.
        }
      }
    });
  }

  // =========================================================================
  // 4. GET_USER: GET DATA DEL USUARIO
  // =========================================================================
  private async handleGetUser(
    payload: UserMigrationMessage,
  ): Promise<UserMigrationResponse> {
    const { eventId, user: userData } = payload;

    logger.info(
      `[GET_USER] Consultando usuario: ${userData.email || userData.cognitoSub}`,
    );

    // Validar que tengamos al menos un identificador
    if (!userData.email && !userData.cognitoSub) {
      throw new Error("[GET_USER] Se requiere email o cognitoSub");
    }

    const whereClause: any = {};
    if (userData.email) whereClause.email = userData.email;
    if (userData.cognitoSub) whereClause.cognito_sub = userData.cognitoSub;

    // Consulta optimizada: Solo traemos lo necesario
    const includeClause = {
      person: true, // Traemos persona plana, sin anidar ubigeos completos
      memberships: {
        where: { is_active: true },
        include: {
          store: {
            select: {
              id: true,
              name: true,
              business_name: true,
              ruc: true,
              logo_url: true,
              is_active: true,
            },
          },
          role: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
        },
      },
    } as const;

    let existingUser = await this.prisma.users.findFirst({
      where: whereClause,
      include: includeClause,
    });

    if (!existingUser) {
      logger.warn(
        `[GET_USER] Usuario no encontrado: ${userData.email || userData.cognitoSub}. Migrando en el momento (lazy migration)...`,
      );

      await this.handleCreateUser(payload);

      existingUser = await this.prisma.users.findFirst({
        where: whereClause,
        include: includeClause,
      });

      if (!existingUser) {
        logger.error(
          `[GET_USER] La migración en el momento no pudo crear al usuario: ${userData.email || userData.cognitoSub}`,
        );
        return { eventId, status: "NOT_FOUND" };
      }

      logger.info(
        `[GET_USER] Usuario migrado en el momento con éxito: ${userData.email || userData.cognitoSub}`,
      );
    }

    // Construcción de respuesta tipada
    const personData = existingUser.person;

    return {
      eventId,
      status: "SUCCESS",
      data: {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          cognitoSub: existingUser.cognito_sub || "",
          isActive: existingUser.is_active ?? true,
          lastLoginAt: existingUser.last_login_at || undefined,
        },
        person: personData
          ? {
              firstName: personData.first_name,
              lastName: personData.last_name,
              fullName: [personData.first_name, personData.last_name]
                .filter(Boolean)
                .join(" "),
              documentNumber: personData.document_number,
              birthDate: personData.birth_date || undefined,
              address: personData.address || undefined,
            }
          : null,
        memberships: (existingUser.memberships || []).map((m: any) => ({
          id: m.id,
          store: {
            id: m.store?.id || "",
            name: m.store?.name || "",
            businessName: m.store?.business_name || undefined,
            ruc: m.store?.ruc || undefined,
            logoUrl: m.store?.logo_url || undefined,
            isActive: m.store?.is_active ?? true,
          },
          role: {
            id: m.role?.id || "",
            name: m.role?.name || "",
            description: m.role?.description || undefined,
          },
          isOwner: m.is_owner,
          employeeCode: m.employee_code || undefined,
          hireDate: m.hire_date || undefined,
          isActive: m.is_active ?? true,
        })),
      },
    };
  }

  private async handleStoreSettings(
    payload: UserMigrationMessage,
  ): Promise<void> {
    const catalog = await getCatalogCache();
    const { store } = payload;

    if (!store?.legacyStoreId) {
      throw new Error("[STORE_SETTINGS] Se requiere store.legacyStoreId");
    }

    logger.info(
      `[STORE_SETTINGS] Procesando configuración para tienda legacy: ${store.legacyStoreId}`,
    );

    await this.prisma.$transaction(async (tx) => {
      // 1. Buscar o Crear Tienda
      let storeRecord = await tx.stores.findFirst({
        where: { legacy_store_id: BigInt(store.legacyStoreId!) },
      });

      if (!storeRecord) {
        logger.warn(
          `[STORE_SETTINGS] Tienda legacy ${store.legacyStoreId} no encontrada. Creándola...`,
        );

        // País por defecto: Perú, resuelto desde el catálogo real (mismo criterio que CREATE_USER).
        const defaultCountryId = catalog.countries["PER"];
        if (!defaultCountryId) {
          throw new Error(
            `[STORE_SETTINGS] País por defecto "PER" no encontrado en catálogo.`,
          );
        }

        storeRecord = await tx.stores.create({
          data: {
            legacy_store_id: BigInt(store.legacyStoreId!),
            name: store.name,
            business_name: store.businessName || null,
            ruc: store.ruc || null,
            logo_url: store.logoUrl || null,
            is_active: store.isActive ?? true,
            currency_code: "PEN", // Default seguro
            timezone: "America/Lima",
            country_id: defaultCountryId,
          },
        });
      }

      // 2. Upsert de Settings
      if (store.settings) {
        logger.info(
          `[STORE_SETTINGS] Actualizando/Creando settings para store_id: ${storeRecord.id}`,
        );

        const settingsData = this.buildStoreSettingsData(store.settings);

        await tx.store_settings.upsert({
          where: { store_id: storeRecord.id },
          create: {
            store_id: storeRecord.id,
            ...settingsData,
          },
          update: {
            ...settingsData,
          },
        });
      }
    });

    logger.info(
      `[STORE_SETTINGS] Configuración procesada exitosamente para tienda legacy: ${store.legacyStoreId}`,
    );
  }
}
