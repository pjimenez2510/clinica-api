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
import { withReadRevision } from './setup/read-revision';
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
  let encounterId: string;
  let glucoseExamId: string;
  let glucoseAnalyteId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    glucoses = 0;

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
    await aTariffConcept(prisma, { code: 'MSP-GLUCOSA-AYUNAS' });
    glucoseAnalyteId = exams.glu.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'medico@clinica.ec', password: PASSWORD })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    encounterId = encounter.id;
    glucoseExamId = exams.glucose.id;
    orderId = await anIssuedGlucoseOrder();
  }

  /** ORD-098. Composed as a draft; a result only comes back for an issued one. */
  async function anIssuedGlucoseOrder(): Promise<string> {
    const order = await post(`/encounters/${encounterId}/orders`, {
      category: 'LABORATORY',
      items: [{ serviceId: glucoseExamId }],
    }).expect(201);
    const id = (order.body as { id: string }).id;
    await post(`/orders/${id}/issue`, {}).expect(200);
    return id;
  }

  // ORD-181. A write on a draft carries the revision a screen just read.
  const post = (path: string, body: object) =>
    withReadRevision(
      prisma,
      path,
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    );

  const put = (path: string, body: object) =>
    withReadRevision(
      prisma,
      path,
      request(app.getHttpServer())
        .put(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    );

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  /**
   * A critical glucose. The first on the scene's order, each later one on an
   * order of its own: a second report with the same determination is
   * `RESULT_ALREADY_REPORTED` (ORD-170).
   */
  let glucoses = 0;
  async function criticalGlucose(): Promise<string> {
    glucoses += 1;
    const target = glucoses === 1 ? orderId : await anIssuedGlucoseOrder();
    const report = await post(`/orders/${target}/reports`, {
      issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 25 }],
    }).expect(201);
    return (report.body as { results: { id: string }[] }).results[0]!.id;
  }

  it('ORD-181 corregir en una pestaña y emitir desde la otra: 412 RECORD_CHANGED, sin número; con la revisión vigente, emite', async () => {
    const draft = await post(`/encounters/${encounterId}/orders`, {
      category: 'LABORATORY',
      items: [{ serviceId: glucoseExamId }],
    }).expect(201);
    // Its lines are written after the order, and each one moves the order's
    // pending state: the revision is whatever the answer says, never assumed.
    const { id, revision: read } = draft.body as {
      id: string;
      revision: number;
    };
    const stored = async () =>
      prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect((await stored()).revision).toBe(read);
    const tab = (
      method: 'put' | 'post',
      path: string,
      ifMatch: string | null,
      body: object,
    ) => {
      // prettier-ignore
      const call = request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`);
      if (ifMatch !== null) call.set('If-Match', ifMatch);
      return call.send(body);
    };

    const corrected = await tab('put', `/orders/${id}`, `"${read}"`, {
      category: 'LABORATORY',
      priority: 'URGENT',
      items: [{ serviceId: glucoseExamId }],
    }).expect(200);
    const now = (corrected.body as { revision: number }).revision;
    expect(now).toBeGreaterThan(read);
    expect(corrected.body).toMatchObject({ priority: 'URGENT' });
    expect((await stored()).revision).toBe(now);

    const stale = await tab('put', `/orders/${id}`, `"${read}"`, {
      category: 'LABORATORY',
      priority: 'ROUTINE',
      items: [{ serviceId: glucoseExamId }],
    }).expect(412);
    expect(stale.body).toMatchObject({
      code: 'RECORD_CHANGED',
      title:
        'Esto cambió en otra pestaña o lo cambió otra persona. Recargue para ver lo guardado',
    });
    await tab('post', `/orders/${id}/issue`, `"${read}"`, {}).expect(412);
    await tab('post', `/orders/${id}/issue`, null, {}).expect(428);
    expect(await stored()).toMatchObject({ status: 'DRAFT', number: null, priority: 'URGENT', revision: now }); // prettier-ignore

    // Control positivo.
    const issued = await tab('post', `/orders/${id}/issue`, `"${now}"`, {}).expect(200); // prettier-ignore
    expect(issued.body).toMatchObject({ status: 'ISSUED' });
  });

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

  it('ORD-143 ORD-144 ORD-148 por HTTP: la corrección de un valor avisado sale en su cola y en el informe, admite su aviso con quién llamó, y un nombre vacío se rechaza', async () => {
    const resultId = await criticalGlucose();
    const notice = {
      outcome: 'NOTIFIED',
      readBack: true,
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    };
    // ORD-148: un nombre vacío de quien llamó no entra.
    const blank = await post(`/orders/results/${resultId}/notices`, { ...notice, callerName: '   ' }); // prettier-ignore
    expect(blank.status).toBe(422);
    expect((blank.body as Problem).errors?.[0]?.field).toBe('callerName');
    expect(await prisma.criticalResultNotice.count()).toBe(0);
    const told = await post(`/orders/results/${resultId}/notices`, {
      ...notice,
      callerName: 'Lcda. Rosa Pilco',
      notifiedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    }).expect(201);
    expect((told.body as { callerName: string }).callerName).toBe('Lcda. Rosa Pilco'); // prettier-ignore

    // Control positivo: sin corrección, la cola está vacía.
    expect((await get('/orders/results/corrections').expect(200)).body).toEqual({ items: [] }); // prettier-ignore

    const reports = await get(`/orders/${orderId}/reports`).expect(200);
    const reportId = (reports.body as { items: { id: string }[] }).items[0]!.id;
    const offered = await get(`/orders/reports/${reportId}/analytes`).expect(200); // prettier-ignore
    expect((offered.body as { items: { id: string }[] }).items.map((a) => a.id)).toEqual([glucoseAnalyteId]); // prettier-ignore
    const corrected = await post(`/orders/reports/${reportId}/correct`, {
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 95 }],
    }).expect(201);
    const standing = (corrected.body as { results: { id: string }[] }).results[0]!.id; // prettier-ignore

    const queue = await get('/orders/results/corrections').expect(200);
    expect(queue.body).toMatchObject({
      items: [{ resultId: standing, valueNumeric: 95, told: { valueNumeric: 25 }, earlierNotices: [{ recipientKind: 'PATIENT', recipientName: null }] }], // prettier-ignore
    });
    const read = await get(`/orders/${orderId}/reports`).expect(200);
    const current = (read.body as { items: { supersededById: string | null; results: { correction: { due: boolean } | null }[] }[] }).items.find((r) => r.supersededById === null); // prettier-ignore
    expect(current?.results[0]?.correction?.due).toBe(true);

    await post(`/orders/results/${standing}/notices`, notice).expect(201);
    expect((await get('/orders/results/corrections').expect(200)).body).toEqual({ items: [] }); // prettier-ignore
  });

  it('ORD-066 ORD-177 con la sede que lo exige, un aviso sin read-back responde 422 nombrando el campo', async () => {
    const resultId = await criticalGlucose();
    await prisma.siteParameter.updateMany({ data: { criticalReadBackRequired: true } }); // prettier-ignore

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

  it('ORD-120 editar el aviso por HTTP lo cambia en el sitio con la sesión como sello, exige la versión vigente, y sus versiones se leen', async () => {
    const resultId = await criticalGlucose();
    const colleague = await createUser(prisma);
    const created = await post(`/orders/results/${resultId}/notices`, {
      outcome: 'NOTIFIED',
      readBack: true,
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    }).expect(201);
    const notice = created.body as { id: string; notifiedAt: string };

    // ORD-066, ORD-177: con la sede que lo exige, editar no levanta el read-back.
    await prisma.siteParameter.updateMany({ data: { criticalReadBackRequired: true } }); // prettier-ignore
    const refused = await put(
      `/orders/results/${resultId}/notices/${notice.id}`,
      {
        expectedEditedAt: null,
        outcome: 'NOTIFIED',
        recipientKind: 'REPRESENTATIVE',
        recipientName: 'La hija de la paciente',
        channel: 'IN_PERSON',
      },
    ).expect(422);
    expect((refused.body as Problem).code).toBe('CRITICAL_READ_BACK_REQUIRED');

    const edited = await put(
      `/orders/results/${resultId}/notices/${notice.id}`,
      {
        expectedEditedAt: null,
        outcome: 'NOTIFIED',
        readBack: true,
        recipientKind: 'REPRESENTATIVE',
        recipientName: 'La hija de la paciente',
        channel: 'IN_PERSON',
        // Ni se lee ni se guarda: quien edita es la sesión.
        editedById: colleague.id,
      },
    ).expect(200);
    expect(edited.body).toMatchObject({
      id: notice.id,
      recipientName: 'La hija de la paciente',
      notifiedAt: notice.notifiedAt,
      notifiedBy: { id: doctorUserId },
      editedBy: { id: doctorUserId, name: 'Ana Villacís' },
    });

    const versions = await get(
      `/orders/results/${resultId}/notices/${notice.id}/versions`,
    ).expect(200);
    expect(versions.body).toMatchObject({
      items: [
        {
          version: 1,
          replacedBy: { id: doctorUserId },
          notice: {
            id: notice.id,
            recipientName: 'La paciente',
            editedBy: null,
          },
        },
      ],
    });

    // La versión que trae el cuerpo ya no es la vigente: 409 con su código.
    const stale = await put(
      `/orders/results/${resultId}/notices/${notice.id}`,
      {
        expectedEditedAt: null,
        outcome: 'NOTIFIED',
        readBack: true,
        recipientKind: 'PATIENT',
        recipientName: 'La paciente',
        channel: 'PHONE',
      },
    ).expect(409);
    expect((stale.body as Problem).code).toBe(
      'CRITICAL_NOTICE_EDITED_CONCURRENTLY',
    );
    // Sin decir sobre qué versión edita, ni se intenta.
    const unversioned = await put(
      `/orders/results/${resultId}/notices/${notice.id}`,
      {
        outcome: 'NOTIFIED',
        readBack: true,
        recipientKind: 'PATIENT',
        recipientName: 'La paciente',
        channel: 'PHONE',
      },
    ).expect(422);
    expect((unversioned.body as Problem).errors?.[0]?.field).toBe(
      'expectedEditedAt',
    );
    // Control positivo: con la versión vigente, entra.
    await put(`/orders/results/${resultId}/notices/${notice.id}`, {
      expectedEditedAt: (edited.body as { editedAt: string }).editedAt,
      outcome: 'NOTIFIED',
      readBack: true,
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
    }).expect(200);

    // Un aviso que no es de ese valor: 404 con su código.
    const otherResult = await criticalGlucose();
    const missing = await put(
      `/orders/results/${otherResult}/notices/${notice.id}`,
      {
        expectedEditedAt: null,
        outcome: 'NO_ANSWER',
        recipientKind: 'PATIENT',
        recipientName: 'La paciente',
        channel: 'PHONE',
      },
    ).expect(404);
    expect((missing.body as Problem).code).toBe('CRITICAL_NOTICE_NOT_FOUND');
  });
});
