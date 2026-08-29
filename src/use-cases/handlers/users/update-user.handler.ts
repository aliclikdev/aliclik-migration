// src/use-cases/handlers/users/update-user.handler.ts

import { PrismaClient } from "@prisma/client";
import { UserMigrationMessage } from "../../../types/sqs-migration.types";
import { getCatalogCache } from "../../../utils/catalog";
import { logger } from "../../../utils/logger";

export class UpdateUserHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: UserMigrationMessage): Promise<void> {
    const catalog = await getCatalogCache();
    const {
      person: personData,
      user: userData,
      store,
      store: { membership } = {},
    } = payload;

    // ✅ Validar que tengamos identificador para encontrar al usuario
    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub) {
      userConditions.push({ cognito_sub: userData.cognitoSub });
    }
    if (userData.email) {
      userConditions.push({ email: userData.email });
    }

    if (userConditions.length === 0) {
      throw new Error(
        "[UPDATE_USER] Se requiere cognitoSub o email para identificar al usuario.",
      );
    }

    await this.prisma.$transaction(async (tx: any) => {
      // ✅ CORREGIDO: Buscar usuario con los filtros
      let user = await tx.users.findFirst({
        where: { OR: userConditions },
        include: { person: true },
      });

      if (!user) {
        throw new Error(
          `[UPDATE_USER] Usuario no encontrado para cognitoSub: ${userData.cognitoSub} o email: ${userData.email}`,
        );
      }

      // ✅ CORREGIDO: Actualizar datos de persona (si existe)
      if (personData && user.person_id) {
        const docTypeId = personData.documentType
          ? (catalog.docTypes[personData.documentType] ?? null)
          : undefined;

        const ubigeoId = personData.ubigeoCode
          ? (catalog.ubigeos[personData.ubigeoCode] ?? null)
          : undefined;

        logger.info(`[UPDATE_USER] Actualizando persona ID: ${user.person_id}`);

        // ✅ CORREGIDO: Preparar datos de actualización con tipos correctos
        const personUpdateData: any = {
          updated_at: new Date(),
        };

        if (personData.firstName !== undefined) {
          personUpdateData.first_name = personData.firstName;
        }
        if (personData.lastName !== undefined) {
          personUpdateData.last_name = personData.lastName;
        }
        if (docTypeId !== undefined) {
          personUpdateData.document_type_id = docTypeId; // ✅ bigint | null
        }
        if (personData.documentNumber !== undefined) {
          personUpdateData.document_number = personData.documentNumber;
        }
        if (ubigeoId !== undefined) {
          personUpdateData.ubigeo_id = ubigeoId; // ✅ bigint | null
        }
        if (personData.address !== undefined) {
          personUpdateData.address = personData.address;
        }
        if (personData.birthDate !== undefined) {
          personUpdateData.birth_date = personData.birthDate
            ? new Date(personData.birthDate)
            : null;
        }

        await tx.persons.update({
          where: { id: user.person_id },
          data: personUpdateData,
        });
      }

      // ✅ CORREGIDO: Actualizar datos de usuario
      logger.info(`[UPDATE_USER] Actualizando datos de usuario ID: ${user.id}`);

      const userUpdateData: any = {
        updated_at: new Date(),
      };

      if (userData.isActive !== undefined) {
        userUpdateData.is_active = userData.isActive;
      }
      if (userData.lastLoginAt !== undefined) {
        userUpdateData.last_login_at = userData.lastLoginAt
          ? new Date(userData.lastLoginAt)
          : null;
      }

      await tx.users.update({
        where: { id: user.id },
        data: userUpdateData,
      });

      // ✅ CORREGIDO: Actualizar membresía (si existe)
      if (membership) {
        // ✅ Buscar storeId usando legacy_store_id del catálogo
        const storeId = store?.legacyStoreId
          ? (catalog.stores[String(store.legacyStoreId)] ?? null)
          : null;

        // ✅ Buscar roleId por nombre
        const roleId = membership.roleName
          ? (catalog.roles[membership.roleName] ?? null)
          : null;

        if (storeId && roleId) {
          logger.info(
            `[UPDATE_USER] Upserting membresía para tienda ID: ${storeId}`,
          );

          // ✅ CORREGIDO: Preparar datos de membresía con bigint
          const membershipData: any = {
            role_id: roleId, // ✅ bigint
            updated_at: new Date(),
          };

          if (membership.isOwner !== undefined) {
            membershipData.is_owner = membership.isOwner;
          }
          if (membership.isActive !== undefined) {
            membershipData.is_active = membership.isActive;
          }
          if (membership.employeeCode !== undefined) {
            membershipData.employee_code = membership.employeeCode;
          }
          if (membership.hireDate !== undefined) {
            membershipData.hire_date = membership.hireDate
              ? new Date(membership.hireDate)
              : null;
          }

          await tx.store_memberships.upsert({
            where: {
              idx_user_store_unique: {
                user_id: user.id, // ✅ bigint
                store_id: storeId, // ✅ bigint
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
            update: membershipData,
          });
        } else {
          logger.warn(
            `[UPDATE_USER] Catálogo incompleto para membresía. ` +
              `Store legacy: ${store?.legacyStoreId} (encontrado: ${!!storeId}), ` +
              `Role: ${membership.roleName} (encontrado: ${!!roleId})`,
          );
        }
      }

      // ✅ CORREGIDO: Actualizar store_settings (si existe y hay cambios)
      if (store?.settings) {
        const storeRecord = store?.legacyStoreId
          ? await tx.stores.findFirst({
              where: { legacy_store_id: BigInt(store.legacyStoreId) },
              select: { id: true },
            })
          : null;

        if (storeRecord) {
          logger.info(
            `[UPDATE_USER] Actualizando settings para store_id: ${storeRecord.id}`,
          );

          const settingsData: any = {
            updated_at: new Date(),
          };

          if (store.settings.currencyCode !== undefined) {
            settingsData.currency_code = store.settings.currencyCode;
          }
          if (store.settings.timezone !== undefined) {
            settingsData.timezone = store.settings.timezone;
          }
          if (store.settings.config !== undefined) {
            settingsData.config = store.settings.config;
          }
          if (store.settings.supportPhone !== undefined) {
            settingsData.support_phone = store.settings.supportPhone;
          }
          if (store.settings.supportEmail !== undefined) {
            settingsData.support_email = store.settings.supportEmail;
          }
          if (store.settings.isEmailTransferVerified !== undefined) {
            settingsData.is_email_transfer_verified =
              store.settings.isEmailTransferVerified;
          }
          if (store.settings.accountVerified !== undefined) {
            settingsData.account_verified = store.settings.accountVerified;
          }

          await tx.store_settings.upsert({
            where: { store_id: storeRecord.id }, // ✅ bigint
            create: {
              store_id: storeRecord.id,
              currency_code: store.settings.currencyCode ?? "PEN",
              timezone: store.settings.timezone ?? "America/Lima",
              config: store.settings.config ?? null,
              support_phone: store.settings.supportPhone ?? null,
              support_email: store.settings.supportEmail ?? null,
              is_email_transfer_verified:
                store.settings.isEmailTransferVerified ?? false,
              account_verified: store.settings.accountVerified ?? false,
            },
            update: settingsData,
          });
        }
      }
    });

    logger.info(
      `[UPDATE_USER] Usuario actualizado exitosamente: ${userData.email}`,
    );
  }
}
