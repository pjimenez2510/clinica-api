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

import { aTariffConcept, seedExams } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The results routes over HTTP, against a real PostgreSQL (ORD-026, ORD-030,
 * ORD-062).
 *
 * What only this level shows: that the body CANNOT name who gave a notice —
 * the session does —, that the trail rows land in `access_audit` and not in a
 * double, and that a future issue date is refused before any row is written.
 */
const PASSWORD = 'el caballo come alfalfa';
const CEDULA = '1710034065';

interface Problem {
  code: string;
  errors?: { field: string }[];
}

describe('los resultados por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let doctorUserId: string;
  let patientId: string;
  let orderId: string;
  let glucoseAnalyteId: string;

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

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await syncAuthorisation(prisma);
    registry.invalidate();

    const site = await createSite(prisma);
    const user = await prisma.user.create({
      data: {
        email: 'medico@clinica.ec',
        firstName: 'Ana',
        lastName: 'Villacís',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    doctorUserId = user.id;
    const practitioner = await prisma.practitioner.create({
      data: { userId: user.id },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: site.id },
    });

    const patient = await createPatient(prisma);
    patientId = patient.id;
    await prisma.patientIdentifier.create({
      data: { patientId, type: 'CEDULA', value: CEDULA },
    });
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId,
    });
    const exams = await seedExams(prisma);
    await aTariffConcept(prisma, { code: 'EX-GLUCOSA-AYUNAS' });
    glucoseAnalyteId = exams.glu.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'medico@clinica.ec', password: PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    const order = await post(`/encounters/${encounter.id}/orders`, {
      category: 'LABORATORY',
      items: [{ examDefinitionId: exams.glucose.id }],
    }).expect(201);
    orderId = (order.body as { id: string }).id;
    // ORD-098. Composed as a draft; a result only comes back for an issued one.
    await post(`/orders/${orderId}/issue`, {}).expect(200);
  }

  const post = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function criticalGlucose(): Promise<string> {
    const report = await post(`/orders/${orderId}/reports`, {
      issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 25 }],
    }).expect(201);
    return (report.body as { results: { id: string }[] }).results[0]!.id;
  }

  it('ORD-062 quién avisó es la sesión aunque el cuerpo diga otra cosa, y la bitácora queda en la base', async () => {
    const resultId = await criticalGlucose();
    const colleague = await createUser(prisma);

    const response = await post(`/orders/results/${resultId}/notices`, {
      outcome: 'NOTIFIED',
      readBack: true,
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
      // Ni se lee ni se guarda: un aviso no se pone a nombre de un colega.
      notifiedById: colleague.id,
    }).expect(201);

    const notice = response.body as { id: string };
    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({
      where: { id: notice.id },
    });
    expect(stored.notifiedById).toBe(doctorUserId);
    expect(
      await prisma.accessAudit.count({
        where: {
          resourceType: 'critical_result_notice',
          resourceId: notice.id,
          userId: doctorUserId,
          action: 'CREATE',
        },
      }),
    ).toBe(1);
  });

  it('ORD-066 un aviso sin read-back responde 422 nombrando el campo', async () => {
    const resultId = await criticalGlucose();

    const response = await post(`/orders/results/${resultId}/notices`, {
      outcome: 'NOTIFIED',
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    }).expect(422);

    expect((response.body as Problem).code).toBe('CRITICAL_READ_BACK_REQUIRED');
    expect((response.body as Problem).errors?.[0]?.field).toBe('readBack');
    expect(await prisma.criticalResultNotice.count()).toBe(0);
  });

  it('ORD-030 un informe con fecha de emisión futura se rechaza y no deja nada', async () => {
    const response = await post(`/orders/${orderId}/reports`, {
      issuedAt: new Date(Date.now() + 3_600_000).toISOString(),
      results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 25 }],
    }).expect(422);

    expect((response.body as Problem).code).toBe('REPORT_ISSUED_IN_FUTURE');
    expect(await prisma.diagnosticReport.count()).toBe(0);

    // Control positivo: con la de hace una hora, entra.
    await criticalGlucose();
    expect(await prisma.diagnosticReport.count()).toBe(1);
  });

  it('ORD-026 buscar por cédula enseña el nombre y deja una fila en la bitácora; la cola sin filtro, ninguna', async () => {
    const unfiltered = await get('/orders/pending').expect(200);
    expect(
      (unfiltered.body as { items: { patientName: string | null }[] }).items[0]
        ?.patientName,
    ).toBeNull();
    expect(
      await prisma.accessAudit.count({ where: { resourceType: 'patient' } }),
    ).toBe(0);

    const byCedula = await get(`/orders/pending?cedula=${CEDULA}`).expect(200);
    expect(
      (byCedula.body as { items: { patientName: string | null }[] }).items[0]
        ?.patientName,
    ).toBe('María Guamán');
    expect(
      await prisma.accessAudit.count({
        where: {
          resourceType: 'patient',
          resourceId: patientId,
          userId: doctorUserId,
          action: 'READ',
        },
      }),
    ).toBe(1);
  });

  it('ORD-030 un informe sin fecha de emisión no entra: ningún «ahora» la sustituye', async () => {
    const response = await post(`/orders/${orderId}/reports`, {
      results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 25 }],
    }).expect(422);

    expect((response.body as Problem).code).toBe('VALIDATION_FAILED');
    expect((response.body as Problem).errors?.[0]?.field).toBe('issuedAt');
    expect(await prisma.diagnosticReport.count()).toBe(0);
  });

  it('ORD-067 una llamada sin respuesta que dice «repitió el valor» se rechaza', async () => {
    const resultId = await criticalGlucose();

    const response = await post(`/orders/results/${resultId}/notices`, {
      outcome: 'NO_ANSWER',
      readBack: true,
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    }).expect(422);

    expect((response.body as Problem).errors?.[0]?.field).toBe('readBack');
    expect(await prisma.criticalResultNotice.count()).toBe(0);

    // Control positivo: el mismo intento, sin read-back, entra.
    await post(`/orders/results/${resultId}/notices`, {
      outcome: 'NO_ANSWER',
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    }).expect(201);
  });
});
