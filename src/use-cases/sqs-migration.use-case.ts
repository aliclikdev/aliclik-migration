// src/use-cases/sqs-migration.use-case.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { getAuroraDb } from '../services/aurora.service';
import { acquireSqsMigrationLock, releaseSqsMigrationLock } from '../services/idempotency.service';
import { getCatalogCache, clearCatalogCache, CatalogCache } from '../utils/catalog';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { UserMigrationMessage } from '../types/sqs-migration.types';

type TxClient = Prisma.TransactionClient;

export async function executeSqsMigration(message: UserMigrationMessage) {
  const { eventId, eventType } = message;

  logger.debug('Ejecutando migración', { eventId, eventType });

  // 1. Idempotencia
  const lock = await acquireSqsMigrationLock(eventId);
  if (!lock) {
    logger.info(`Evento ${eventId} ya fue procesado, ignorando`);
    return { eventId, status: 'ALREADY_PROCESSED' };
  }

  try {
    const auroraDb = getAuroraDb();
    const cache = await getCatalogCache();

    if (!cache || Object.keys(cache).length === 0) {
      throw new Error('Catálogos no disponibles');
    }

    let result;
    switch (eventType) {
      case 'CREATE_USER':
        result = await handleCreateUser(auroraDb, message, cache);
        break;
      case 'UPDATE_USER':
        result = await handleUpdateUser(auroraDb, message, cache);
        break;
      default:
        throw new Error(`Tipo de evento no soportado: ${eventType}`);
    }

    await releaseSqsMigrationLock(eventId, 'PROCESSED');

    logger.info(`✅ Evento ${eventId} procesado exitosamente`, {
      eventType,
      result,
    });

    return { eventId, status: 'SUCCESS', eventType };

  } catch (error) {
    await releaseSqsMigrationLock(eventId, 'FAILED');

    logger.error(`❌ Error procesando evento ${eventId}`, {
      error: error instanceof Error ? error.message : 'Error desconocido',
      eventType,
    });

    throw error;
  }
}

/**
 * Resuelve el id de un rol contra el catálogo cacheado. A diferencia de
 * `stores` (que sí tenía fallback a consulta directa), `roles` no lo tenía:
 * si se creaba un rol nuevo después del warmup de este contenedor Lambda,
 * cualquier evento con ese rol fallaba hasta que el contenedor se reciclara.
 * Aquí, si no se encuentra en cache, se fuerza una recarga completa del
 * catálogo una vez antes de fallar definitivamente.
 */
async function resolveRoleId(cache: CatalogCache, role: string): Promise<string> {
  let roleId = cache.roles[role];

  if (!roleId) {
    clearCatalogCache();
    const refreshed = await getCatalogCache();
    Object.assign(cache, refreshed);
    roleId = cache.roles[role];
  }

  if (!roleId) {
    throw new Error(`Rol ${role} no encontrado en Aurora`);
  }

  return roleId;
}

async function resolveStoreId(
  tx: TxClient,
  cache: CatalogCache,
  storeLegacyId: number
): Promise<string> {
  let storeId = cache.stores[String(storeLegacyId)];

  if (!storeId) {
    const existingStore = await tx.store.findFirst({
      where: { legacyStoreId: storeLegacyId },
    });

    if (existingStore) {
      storeId = existingStore.id;
    } else {
      storeId = uuidv4();
      await tx.store.create({
        data: {
          id: storeId,
          legacyStoreId: storeLegacyId,
          name: `Tienda ${storeLegacyId}`,
          isActive: true,
        },
      });
    }
    cache.stores[String(storeLegacyId)] = storeId;
  }

  return storeId;
}

async function handleCreateUser(auroraDb: PrismaClient, message: UserMigrationMessage, cache: CatalogCache) {
  const { person, user, membership } = message;

  logger.debug('Creando usuario', {
    documentNumber: person.documentNumber,
    email: user.email,
    cognitoSub: user.cognitoSub,
  });

  // Validaciones
  if (!person.firstName || !person.lastName || !person.documentNumber) {
    throw new Error('Campos obligatorios faltantes en persona');
  }

  if (!user.email || !user.cognitoSub) {
    throw new Error('Campos obligatorios faltantes en usuario');
  }

  // Validar duplicados en Person
  const existingPerson = await auroraDb.persons.findFirst({
    where: {
      OR: [
        { document_number: person.documentNumber },
        person.legacyPersonId != null ? { legacy_person_id: person.legacyPersonId } : undefined,
      ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause)),
    },
  });

  if (existingPerson) {
    throw new Error(`Persona con documento ${person.documentNumber} ya existe`);
  }

  // Validar duplicados en User
  const existingUser = await auroraDb.user.findFirst({
    where: {
      OR: [
        { email: user.email },
        { cognitoSub: user.cognitoSub },
      ],
    },
  });

  if (existingUser) {
    throw new Error(`Usuario con email ${user.email} o cognitoSub ${user.cognitoSub} ya existe`);
  }

  // Validar catálogos
  const docTypeKey = person.documentType || 'DNI';
  const documentTypeId = cache.docTypes[docTypeKey];
  if (!documentTypeId) {
    throw new Error(`Tipo de documento ${docTypeKey} no encontrado en catálogo`);
  }

  let result;

  await auroraDb.$transaction(async (tx: TxClient) => {
    // 1. Crear Person
    const personId = uuidv4();
    await tx.persons.create({
      data: {
        id: personId,
        legacy_person_id: person.legacyPersonId || null,
        first_name: person.firstName,
        last_name: person.lastName,
        document_number: person.documentNumber,
        document_type_id: documentTypeId,
        ubigeo_id: person.ubigeoCode ? cache.ubigeos[person.ubigeoCode] || null : null,
        address: person.address || null,
      },
    });

    // 2. Crear User
    const userId = uuidv4();
    await tx.user.create({
      data: {
        id: userId,
        personId: personId,
        email: user.email,
        passwordHash: '',
        cognitoSub: user.cognitoSub,
        isActive: user.isActive !== false,
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : null,
        // phone: user.phone || null,
      },
    });

    // 3. Crear o Resolver Store y Membership
    if (membership) {
      const storeId = await resolveStoreId(tx, cache, membership.storeLegacyId);
      const roleId = await resolveRoleId(cache, membership.role);

      await tx.storeMembership.create({
        data: {
          id: uuidv4(),
          userId: userId,
          storeId: storeId,
          roleId: roleId,
          isActive: membership.isActive !== false,
        },
      });
    }

    result = {
      personId,
      userId,
      action: 'CREATE_USER',
      membershipCreated: !!membership,
    };
  });

  return result;
}

async function handleUpdateUser(auroraDb: PrismaClient, message: UserMigrationMessage, cache: CatalogCache) {
  const { person, user, membership } = message;

  logger.debug('Actualizando usuario', {
    email: user.email,
    cognitoSub: user.cognitoSub,
  });

  if (!user.email && !user.cognitoSub) {
    throw new Error('Se requiere email o cognitoSub para actualizar usuario');
  }

  let result;

  await auroraDb.$transaction(async (tx: TxClient) => {
    // 1. Buscar User existente
    const existingUser = await tx.user.findFirst({
      where: {
        OR: [
          user.email ? { email: user.email } : undefined,
          user.cognitoSub ? { cognitoSub: user.cognitoSub } : undefined,
        ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause)),
      },
      include: {
        person: true,
        memberships: true,
      },
    });

    if (!existingUser) {
      throw new Error(`Usuario no encontrado: ${user.email || user.cognitoSub}`);
    }

    // 1.b Si se está cambiando el email, validar que no choque con otro usuario.
    // Antes no se validaba: el UPDATE podía fallar con un error crudo de
    // constraint único de Prisma, o en el peor caso (email igual a otro
    // usuario distinto al que se está tocando) dar un resultado confuso.
    if (user.email && user.email !== existingUser.email) {
      const emailTaken = await tx.user.findFirst({
        where: {
          email: user.email,
          id: { not: existingUser.id },
        },
      });

      if (emailTaken) {
        throw new Error(`El email ${user.email} ya está en uso por otro usuario`);
      }
    }

    // 2. Actualizar Person
    if (existingUser.person && person) {
      const personUpdateData: Prisma.personsUpdateInput = {};
      if (person.firstName) personUpdateData.first_name = person.firstName;
      if (person.lastName) personUpdateData.last_name = person.lastName;
      if (person.documentNumber) personUpdateData.document_number = person.documentNumber;
      if (person.address !== undefined) personUpdateData.address = person.address;
      if (person.documentType && cache.docTypes[person.documentType]) {
        personUpdateData.document_types = { connect: { id: cache.docTypes[person.documentType] } };
      }
      if (person.ubigeoCode && cache.ubigeos[person.ubigeoCode]) {
        personUpdateData.ubigeos = { connect: { id: cache.ubigeos[person.ubigeoCode] } };
      }

      if (Object.keys(personUpdateData).length > 0) {
        await tx.persons.update({
          where: { id: existingUser.id },
          data: personUpdateData,
        });
      }
    }

    // 3. Actualizar User
    const userUpdateData: Prisma.UserUpdateInput = {};
    if (user.isActive !== undefined) userUpdateData.isActive = user.isActive;
    // if (user.phone) userUpdateData.phone = user.phone;
    if (user.email) userUpdateData.email = user.email;

    if (Object.keys(userUpdateData).length > 0) {
      await tx.user.update({
        where: { id: existingUser.id },
        data: userUpdateData,
      });
    }

    // 4. Actualizar o Crear StoreMembership (Upsert)
    if (membership) {
      const storeId = await resolveStoreId(tx, cache, membership.storeLegacyId);
      const roleId = await resolveRoleId(cache, membership.role);

      const existingMembership = existingUser.memberships?.find(
        (m) => m.storeId === storeId
      );

      if (existingMembership) {
        const membershipUpdateData: Prisma.StoreMembershipUpdateInput = {};
        if (membership.role) membershipUpdateData.role = { connect: { id: roleId } };
        if (membership.isActive !== undefined) {
          membershipUpdateData.isActive = membership.isActive;
        }

        if (Object.keys(membershipUpdateData).length > 0) {
          await tx.storeMembership.update({
            where: { id: existingMembership.id },
            data: membershipUpdateData,
          });
        }
      } else {
        await tx.storeMembership.create({
          data: {
            id: uuidv4(),
            userId: existingUser.id,
            storeId: storeId,
            roleId: roleId,
            isActive: membership.isActive !== false,
          },
        });
      }
    }

    result = {
      userId: existingUser.id,
      action: 'UPDATE_USER',
      updated: true,
    };
  });

  return result;
}