// src/use-cases/handlers/users/create-user.handler.ts
import { PrismaClient } from "@prisma/client";
import { UserMigrationMessage } from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";

export class DeleteUserHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(payload: UserMigrationMessage): Promise<void> {
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

    await this.prisma.$transaction(async (tx: any) => {
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

    logger.info(
      `[CREATE_USER] Ejecutado por handler separado: ${userData.email}`,
    );
  }
}
