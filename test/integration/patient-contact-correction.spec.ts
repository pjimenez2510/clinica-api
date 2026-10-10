import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * PA-075 and PA-076 as caja reaches them (D-205 §4): the contact route with
 * the factory CAJA role and a REAL session, against PostgreSQL. The trail is
 * read from `patient_change_history` itself, not from the service's word.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string; code: string }[];
}

describe('el contacto de la ficha desde caja (PA-075, PA-076)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let cashierToken: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({
              totalHits: 1,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            }),
        })
        .compile();

      app = moduleRef.createNestApplication<NestExpressApplication>({
        bodyParser: false,
      });
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
    patientId = (await createPatient(prisma)).id;
    cashierToken = await signIn('CAJA', 'caja@clinica.ec', '1710034065');
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** Synthetic cedula with a computed check digit, never a real person's. */
  async function signIn(roleCode: string, email: string, cedula: string) {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Caicedo',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const patch = (path: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(body);

  it('PA-075 caja corrige el correo, el teléfono y la dirección, y cada cambio deja su fila de histórico', async () => {
    const response = await patch(`/patients/${patientId}/contact`, {
      email: 'maria.guaman@correo.ec',
      phone: '0991234567',
      residenceAddressLine: 'Av. Amazonas y Colón',
    }).expect(204);

    // PA-076: nothing of the chart comes back — the write is not a read.
    expect(response.body).toEqual({});
    const stored = await prisma.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { email: true, phone: true, residenceAddressLine: true },
    });
    expect(stored).toEqual({
      email: 'maria.guaman@correo.ec',
      phone: '0991234567',
      residenceAddressLine: 'Av. Amazonas y Colón',
    });
    const trail = await prisma.patientChangeHistory.findMany({
      where: { patientId },
      select: { field: true, valueBefore: true, valueAfter: true },
      orderBy: { field: 'asc' },
    });
    expect(trail).toEqual([
      { field: 'email', valueBefore: null, valueAfter: 'maria.guaman@correo.ec' }, // prettier-ignore
      { field: 'phone', valueBefore: null, valueAfter: '0991234567' },
      { field: 'residenceAddressLine', valueBefore: null, valueAfter: 'Av. Amazonas y Colón' }, // prettier-ignore
    ]);
  });

  it('PA-075 un cuerpo con el apellido se rechaza entero y nada cambia; sin el apellido, pasa', async () => {
    const refused = await patch(`/patients/${patientId}/contact`, {
      email: 'otra@correo.ec',
      familyName: 'Andrade',
    }).expect(422);
    expect((refused.body as Problem).errors?.[0]).toMatchObject({
      code: 'UNKNOWN_FIELD',
    });

    const untouched = await prisma.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { email: true, familyName: true },
    });
    expect(untouched).toEqual({ email: null, familyName: 'Guamán' });
    expect(await prisma.patientChangeHistory.count({ where: { patientId } })).toBe(0); // prettier-ignore

    // Positive control: the same body without the surname goes through.
    await patch(`/patients/${patientId}/contact`, {
      email: 'otra@correo.ec',
    }).expect(204);
    expect(
      (
        await prisma.patient.findUniqueOrThrow({
          where: { id: patientId },
          select: { email: true },
        })
      ).email,
    ).toBe('otra@correo.ec');
  });

  it('PA-075 un correo mal escrito se rechaza en su campo, y un cuerpo vacío no es un 200', async () => {
    const malformed = await patch(`/patients/${patientId}/contact`, {
      email: 'no-es-un-correo',
    }).expect(422);
    expect((malformed.body as Problem).errors?.[0]?.field).toBe('email');

    await patch(`/patients/${patientId}/contact`, {}).expect(422);
  });

  it('PA-075 una ficha unificada no se corrige por el contacto', async () => {
    const survivor = await createPatient(prisma);
    await prisma.patient.update({
      where: { id: patientId },
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    const refused = await patch(`/patients/${patientId}/contact`, {
      email: 'maria@correo.ec',
    }).expect(409);
    expect((refused.body as Problem).code).toBe('PATIENT_MERGED');
  });

  it('PA-076 caja trae el permiso de fábrica y con él no corrige la ficha entera', async () => {
    const caja = await prisma.role.findUniqueOrThrow({
      where: { code: 'CAJA' },
      select: { permissions: { select: { permission: { select: { code: true } } } } }, // prettier-ignore
    });
    expect(caja.permissions.map((grant) => grant.permission.code)).toContain(
      'patient:contact:write',
    );

    const refused = await patch(`/patients/${patientId}`, {
      familyName: 'Andrade',
    }).expect(403);
    expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');
    expect(
      (
        await prisma.patient.findUniqueOrThrow({
          where: { id: patientId },
          select: { familyName: true },
        })
      ).familyName,
    ).toBe('Guamán');
  });
});
