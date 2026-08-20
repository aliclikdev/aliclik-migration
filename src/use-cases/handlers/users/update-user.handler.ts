// src/use-cases/handlers/users/create-user.handler.ts
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

    await this.prisma.$transaction(async (tx: any) => {
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

    logger.info(
      `[CREATE_USER] Ejecutado por handler separado: ${userData.email}`,
    );
  }
}
