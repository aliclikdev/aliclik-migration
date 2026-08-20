// src/use-cases/handlers/users/create-user.handler.ts
import { PrismaClient } from "@prisma/client";
import {
  UserMigrationMessage,
  UserMigrationResponse,
} from "../../../types/sqs-migration.types";
import { logger } from "../../../utils/logger";
import { CreateUserHandler } from "./create-user.handler";

export class GetUserHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly createUserhandler: CreateUserHandler,
  ) {}

  async execute(payload: UserMigrationMessage): Promise<UserMigrationResponse> {
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

      await this.createUserhandler.execute(payload);

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
}
