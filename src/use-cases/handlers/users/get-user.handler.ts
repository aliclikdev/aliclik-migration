// src/use-cases/handlers/users/get-user.handler.ts

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
    private readonly createUserHandler: CreateUserHandler,
  ) {}

  async execute(payload: UserMigrationMessage): Promise<UserMigrationResponse> {
    const { eventId, user: userData } = payload;

    logger.info(
      `[GET_USER] Consultando usuario: ${userData.email || userData.cognitoSub}`,
    );

    if (!userData.email && !userData.cognitoSub) {
      throw new Error("[GET_USER] Se requiere email o cognitoSub");
    }

    // ============================================
    // 1. BUSCAR USUARIO EXISTENTE
    // ============================================

    const whereClause: any = {};
    if (userData.email) {
      whereClause.email = userData.email;
    }
    if (userData.cognitoSub) {
      whereClause.cognito_sub = userData.cognitoSub;
    }

    // ✅ CORREGIDO: Incluir relaciones para obtener datos completos
    const includeClause = {
      persons: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          document_number: true,
          document_type_id: true,
          birth_date: true,
          ubigeo_id: true,
          address: true,
        },
      },
      store_memberships: {
        where: { is_active: true },
        include: {
          stores: {
            select: {
              id: true,
              name: true,
              business_name: true,
              ruc: true,
              logo_url: true,
              is_active: true,
              legacy_store_id: true,
            },
          },
          roles: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
        },
      },
    } as const;

    let existingUser = await this.prisma.user.findFirst({
      where: whereClause,
      include: includeClause,
    });

    // ============================================
    // 2. SI NO EXISTE, MIGRAR EN EL MOMENTO (LAZY MIGRATION)
    // ============================================

    if (!existingUser) {
      logger.warn(
        `[GET_USER] Usuario no encontrado: ${userData.email || userData.cognitoSub}. Migrando en el momento (lazy migration)...`,
      );

      try {
        // ✅ CORREGIDO: Ejecutar createUserHandler para migrar el usuario
        await this.createUserHandler.execute(payload);

        // ✅ CORREGIDO: Buscar nuevamente después de la migración
        existingUser = await this.prisma.user.findFirst({
          where: whereClause,
          include: includeClause,
        });

        if (!existingUser) {
          logger.error(
            `[GET_USER] La migración en el momento no pudo crear al usuario: ${userData.email || userData.cognitoSub}`,
          );
          return {
            eventId,
            status: "NOT_FOUND",
          };
        }

        logger.info(
          `[GET_USER] Usuario migrado en el momento con éxito: ${userData.email || userData.cognitoSub}`,
        );
      } catch (error) {
        logger.error(
          `[GET_USER] Error durante la migración en el momento:`,
          error,
        );
        return {
          eventId,
          status: "NOT_FOUND",
        };
      }
    }

    // ============================================
    // 3. CONSTRUIR RESPUESTA
    // ============================================

    const personData = existingUser.persons;

    // ✅ CORREGIDO: Mapear membresías con tipos correctos (bigint)
    const memberships = (existingUser.store_memberships || []).map(
      (m: any) => ({
        id: m.id, // ✅ bigint
        store: {
          id: m.stores?.id || "", // ✅ bigint (convertido a string para compatibilidad)
          name: m.stores?.name || "",
          businessName: m.stores?.business_name || undefined,
          ruc: m.stores?.ruc || undefined,
          logoUrl: m.stores?.logo_url || undefined,
          isActive: m.stores?.is_active ?? true,
        },
        role: {
          id: m.roles?.id || "", // ✅ bigint (convertido a string para compatibilidad)
          name: m.roles?.name || "",
          description: m.roles?.description || undefined,
        },
        isOwner: m.is_owner,
        employeeCode: m.employee_code || undefined,
        hireDate: m.hire_date || undefined,
        isActive: m.is_active ?? true,
      }),
    );

    // ✅ CORREGIDO: Construir respuesta con tipos correctos
    const response: UserMigrationResponse = {
      eventId,
      status: "SUCCESS",
      data: {
        user: {
          id: existingUser.id, // ✅ bigint
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
        memberships: memberships,
        termsStatus: null, // ✅ Se puede implementar si es necesario
      },
    };

    logger.info(
      `[GET_USER] Usuario encontrado: ${existingUser.email} (id: ${existingUser.id})`,
    );

    return response;
  }
}
