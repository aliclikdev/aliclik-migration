// src/use-cases/handlers/users/delete-user.handler.ts

import { PrismaClient } from "@prisma/client";
import { UserMigrationMessage } from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";

export class DeleteUserHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: UserMigrationMessage): Promise<void> {
    const { user: userData } = payload;

    // ============================================
    // 1. VALIDAR IDENTIFICADORES
    // ============================================

    const userConditions: Array<{ cognito_sub?: string; email?: string }> = [];
    if (userData.cognitoSub) {
      userConditions.push({ cognito_sub: userData.cognitoSub });
    }
    if (userData.email) {
      userConditions.push({ email: userData.email });
    }

    if (userConditions.length === 0) {
      logger.warn(
        "[DELETE_USER] No se proporcionó cognitoSub ni email para eliminar.",
      );
      return;
    }

    // ============================================
    // 2. BUSCAR Y DESACTIVAR USUARIO
    // ============================================

    await this.prisma.$transaction(async (tx: any) => {
      // ✅ CORREGIDO: Buscar usuario por email o cognito_sub
      const user = await tx.users.findFirst({
        where: { OR: userConditions },
        select: {
          id: true,
          person_id: true,
          is_active: true,
          email: true,
          cognito_sub: true,
        },
      });

      if (!user) {
        logger.warn(
          `[DELETE_USER] Usuario no encontrado para desactivar ` +
            `(email: ${userData.email}, cognitoSub: ${userData.cognitoSub}).`,
        );
        return;
      }

      if (!user.is_active) {
        logger.info(
          `[DELETE_USER] Usuario ID ${user.id} ya se encuentra inactivo.`,
        );
        return;
      }

      logger.info(
        `[DELETE_USER] Desactivando usuario: ${user.email} (ID: ${user.id})`,
      );

      // ============================================
      // 3. DESACTIVAR MEMBRESÍAS DEL USUARIO
      // ============================================

      // ✅ CORREGIDO: Desactivar todas las membresías activas del usuario
      const membershipsUpdated = await tx.store_memberships.updateMany({
        where: {
          user_id: user.id, // ✅ bigint
          is_active: true,
        },
        data: {
          is_active: false,
          updated_at: new Date(),
        },
      });

      logger.info(
        `[DELETE_USER] ${membershipsUpdated.count} membresías desactivadas para usuario ID: ${user.id}`,
      );

      // ============================================
      // 4. DESACTIVAR SESSIONES DEL USUARIO (SI EXISTE)
      // ============================================

      // ✅ Si existe tabla de sesiones, desactivarlas
      try {
        // Verificar si existe la tabla Session (del sistema legacy)
        const sessionsUpdated = await tx.session.updateMany({
          where: {
            userId: user.id, // ✅ bigint
            isActive: true,
          },
          data: {
            isActive: false,
            updatedAt: new Date(),
          },
        });

        if (sessionsUpdated.count > 0) {
          logger.info(
            `[DELETE_USER] ${sessionsUpdated.count} sesiones desactivadas para usuario ID: ${user.id}`,
          );
        }
      } catch (error) {
        // La tabla Session puede no existir en la nueva BD
        logger.debug(
          `[DELETE_USER] No se pudo desactivar sesiones (tabla puede no existir): ${error}`,
        );
      }

      // ============================================
      // 5. DESACTIVAR TOKENS DEL USUARIO (SI EXISTE)
      // ============================================

      try {
        // Verificar si existe la tabla TokenBlacklist
        const tokensUpdated = await tx.tokenBlacklist.updateMany({
          where: {
            userId: user.id, // ✅ bigint
            isActive: true,
          },
          data: {
            isActive: false,
            updatedAt: new Date(),
          },
        });

        if (tokensUpdated.count > 0) {
          logger.info(
            `[DELETE_USER] ${tokensUpdated.count} tokens desactivados para usuario ID: ${user.id}`,
          );
        }
      } catch (error) {
        // La tabla TokenBlacklist puede no existir en la nueva BD
        logger.debug(
          `[DELETE_USER] No se pudo desactivar tokens (tabla puede no existir): ${error}`,
        );
      }

      // ============================================
      // 6. DESACTIVAR USUARIO
      // ============================================

      // ✅ CORREGIDO: Desactivar usuario (soft delete)
      await tx.users.update({
        where: { id: user.id }, // ✅ bigint
        data: {
          is_active: false,
          updated_at: new Date(),
          // Opcional: limpiar cognito_sub para liberar el identificador
          // cognito_sub: null,
        },
      });

      logger.info(
        `[DELETE_USER] Usuario desactivado exitosamente: ${user.email} (ID: ${user.id})`,
      );

      // ============================================
      // 7. VERIFICAR SI LA PERSONA QUEDA SIN USUARIOS
      // ============================================

      if (user.person_id) {
        // ✅ CORREGIDO: Contar usuarios activos de la misma persona
        const otherActiveUsers = await tx.users.count({
          where: {
            person_id: user.person_id, // ✅ bigint
            id: { not: user.id },
            is_active: true,
          },
        });

        if (otherActiveUsers === 0) {
          logger.info(
            `[DELETE_USER] Persona ID ${user.person_id} queda sin usuarios activos. ` +
              `Considerando si debe desactivarse también.`,
          );

          // Opcional: Desactivar la persona si no tiene otros usuarios activos
          // Esto es un soft delete, no se elimina físicamente
          // await tx.persons.update({
          //   where: { id: user.person_id },
          //   data: { is_active: false },
          // });
        } else {
          logger.info(
            `[DELETE_USER] Persona ID ${user.person_id} tiene ${otherActiveUsers} usuarios activos restantes.`,
          );
        }
      }
    });

    logger.info(
      `[DELETE_USER] Proceso de desactivación completado para: ${userData.email || userData.cognitoSub}`,
    );
  }
}
