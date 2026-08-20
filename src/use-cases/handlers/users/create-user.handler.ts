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
      currency_code: settings.currencyCode,
      timezone: settings.timezone,
      config: settings.config,
      support_phone: settings.supportPhone,
      support_email: settings.supportEmail,
      is_email_transfer_verified: settings.isEmailTransferVerified,
      account_verified: settings.accountVerified,
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

    await this.prisma.$transaction(async (tx: any) => {
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

    logger.info(
      `[CREATE_USER] Ejecutado por handler separado: ${userData.email}`,
    );
  }
}
