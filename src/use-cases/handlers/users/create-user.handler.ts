// src/use-cases/handlers/users/create-user.handler.ts

import { PrismaClient } from "@prisma/client";
import {
  StoreWithDetails,
  UserMigrationMessage,
} from "../../../types/sqs-migration.types";
import { getCatalogCache } from "../../../utils/catalog";
import { logger } from "../../../utils/logger";

export class CreateUserHandler {
  constructor(private readonly prisma: PrismaClient) {}

  private buildStoreSettingsData(
    settings: NonNullable<StoreWithDetails["settings"]>,
  ) {
    return {
      currency_code: settings.currencyCode ?? "PEN",
      timezone: settings.timezone ?? "America/Lima",
      config: settings.config ?? null,
      support_phone: settings.supportPhone ?? null,
      support_email: settings.supportEmail ?? null,
      is_email_transfer_verified: settings.isEmailTransferVerified ?? false,
      account_verified: settings.accountVerified ?? false,
    };
  }

  async execute(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const {
      person: personData,
      user: userData,
      store,
      store: { membership } = {},
    } = payload;

    const isExplicitCreate = payload.eventType === "CREATE_USER";

    // ✅ Validaciones
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

    // ✅ CORREGIDO: Obtener IDs del catálogo como bigint | null
    const docTypeId = personData.documentType
      ? (catalog.docTypes[personData.documentType] ?? null)
      : null;

    const ubigeoId = personData.ubigeoCode
      ? (catalog.ubigeos[personData.ubigeoCode] ?? null)
      : null;

    await this.prisma.$transaction(async (tx: any) => {
      // ============================================
      // 1. BUSCAR O CREAR PERSONA
      // ============================================

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

        // ✅ CORREGIDO: Crear persona con bigint
        person = await tx.persons.create({
          data: {
            legacy_person_id: personData.legacyPersonId
              ? BigInt(personData.legacyPersonId)
              : null,
            first_name: personData.firstName,
            last_name: personData.lastName,
            document_type_id: docTypeId, // ✅ bigint | null
            document_number: personData.documentNumber || null,
            ubigeo_id: ubigeoId, // ✅ bigint | null
            address: personData.address || null,
          },
        });
      }

      // ============================================
      // 2. BUSCAR O CREAR USUARIO
      // ============================================

      logger.info(
        `[CREATE_USER] Creando/Actualizando usuario: ${userData.email}`,
      );

      // ✅ CORREGIDO: user.id es bigint
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
          person_id: person.id, // ✅ bigint
          email: userData.email,
          cognito_sub: userData.cognitoSub,
          is_active: userData.isActive ?? true,
          last_login_at: userData.lastLoginAt
            ? new Date(userData.lastLoginAt)
            : null,
        },
      });

      // ============================================
      // 3. PROCESAR MEMBRESÍA (STORE + ROLE + USER)
      // ============================================

      if (membership) {
        // ✅ CORREGIDO: Buscar store por legacy_store_id
        let storeFind = await tx.stores.findFirst({
          where: { legacy_store_id: BigInt(store?.legacyStoreId || 0) },
        });

        let resolvedStoreId: bigint; // ✅ bigint

        if (!storeFind) {
          logger.warn(
            `[CREATE_USER] Tienda legacy ${store.legacyStoreId} no existe. Creándola...`,
          );

          // ✅ CORREGIDO: country_id es bigint
          const defaultCountryId = catalog.countries["PER"];
          if (!defaultCountryId) {
            throw new Error(
              `[CREATE_USER] País por defecto "PER" no encontrado en catálogo.`,
            );
          }

          const storeCreate = await tx.stores.create({
            data: {
              legacy_store_id: BigInt(store.legacyStoreId || 0),
              name: store.name || `Tienda Legacy ${store.legacyStoreId}`,
              business_name: store.businessName || null,
              ruc: store.ruc || null,
              logo_url: store.logoUrl || null,
              currency_code: "PEN",
              timezone: "America/Lima",
              is_active: store.isActive ?? true,
              country_id: defaultCountryId, // ✅ bigint
            },
          });
          resolvedStoreId = storeCreate.id;
        } else {
          resolvedStoreId = storeFind.id;
        }

        // ✅ CORREGIDO: role_id es bigint
        const roleId = catalog.roles[membership.roleName];
        if (!roleId) {
          throw new Error(
            `Rol ${membership.roleName} no encontrado en catálogo.`,
          );
        }

        logger.info(
          `[CREATE_USER] Vinculando usuario ${createdUser.id} a tienda ${resolvedStoreId}`,
        );

        // ✅ CORREGIDO: Crear membresía con bigint
        await tx.store_memberships.upsert({
          where: {
            idx_user_store_unique: {
              user_id: createdUser.id, // ✅ bigint
              store_id: resolvedStoreId, // ✅ bigint
            },
          },
          create: {
            user_id: createdUser.id,
            store_id: resolvedStoreId,
            role_id: roleId, // ✅ bigint
            is_owner: membership.isOwner ?? false,
            is_active: membership.isActive ?? true,
            employee_code: membership.employeeCode || null,
            hire_date: membership.hireDate
              ? new Date(membership.hireDate)
              : null,
          },
          update: {
            role_id: roleId,
            is_owner: membership.isOwner ?? undefined,
            is_active: membership.isActive ?? undefined,
            employee_code: membership.employeeCode ?? undefined,
            hire_date: membership.hireDate
              ? new Date(membership.hireDate)
              : undefined,
          },
        });

        // ============================================
        // 4. CREAR STORE SETTINGS (SI NO EXISTE)
        // ============================================

        if (!isExplicitCreate && store.settings) {
          logger.info(
            `[GET_USER] Actualizando/Creando settings para store_id: ${resolvedStoreId} (migración perezosa)`,
          );
          const settingsData = this.buildStoreSettingsData(store.settings);
          await tx.store_settings.upsert({
            where: { store_id: resolvedStoreId }, // ✅ bigint
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

      // ============================================
      // 5. PROCESAR TERMS ACCEPTANCE (SI EXISTE)
      // ============================================

      if (payload.termsAcceptance) {
        const { termsId, version, ipAddress, userAgent, comment } =
          payload.termsAcceptance;

        logger.info(
          `[CREATE_USER] Procesando terms acceptance para usuario ${createdUser.id}`,
        );

        // ✅ CORREGIDO: terms_id es bigint
        await tx.user_terms_acceptances.upsert({
          where: {
            idx_user_terms_unique: {
              user_id: createdUser.id,
              terms_id: termsId, // ✅ bigint
            },
          },
          create: {
            user_id: createdUser.id,
            terms_id: termsId, // ✅ bigint
            accepted_at: new Date(),
            ip_address: ipAddress || null,
            user_agent: userAgent || null,
          },
          update: {
            accepted_at: new Date(),
            ip_address: ipAddress || null,
            user_agent: userAgent || null,
          },
        });
      }
    });

    logger.info(
      `[CREATE_USER] Usuario creado/actualizado exitosamente: ${userData.email}`,
    );
  }
}
