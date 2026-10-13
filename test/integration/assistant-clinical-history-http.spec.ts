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
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import {
  aTariffConcept,
  GLUCOSE_MSP_CODE,
  placeIssued,
  seedExams,
} from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createIssuedPrescription,
  createPatient,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-200 to AS-207, SC-098 — `GET /patients/:id/clinical-history`, against a
 * real PostgreSQL 18, real sessions and reports registered (and corrected) by
 * the orders service itself, so every flag is the one the laboratory path
 * computed.
 *
 * THE SCENE. The survivor S, at the doctor's site: a glucose of 150 corrected
 * to 182 (HIGH), a cancelled report, an attention annulled with its own
 * result, a 30-day enalapril and a 7-day amoxicillin issued twenty days ago,
 * an annulled ibuprofen. At a site the doctor does not cover: a glucose of
 * 300. The duplicate D, merged into S: a glucose of 92 (NORMAL).
 *
 * CONTROL POSITIVO in every exclusion: the row is in the table, and a doctor
 * granted at clinic level reads the other site's glucose through the same
 * route.
 */
const PASSWORD = 'el caballo come alfalfa';
const DAY = 86_400_000;

interface ResultBody {
  id: string;
  orderId: string;
  analyteDisplay: string;
  valueNumeric: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  abnormalFlag: string | null;
  seriesKey: string | null;
  fromMergedChart: boolean;
}

interface HistoryBody {
  patientId: string;
  results: { items: ResultBody[]; total: number };
  medications: {
    items: { genericName: string; status: string; endsOn: string | null }[];
    prescriptionTotal: number;
  };
  visits: { total: number };
  timeline: { date: string; items: { kind: string; resultId?: string }[] }[];
  hasEntriesOutsideScope: boolean;
}

describe('la historia sin modelo por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let otherSiteId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let receptionToken: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // AS-200: the history does not depend on the assistant's switch.
        .overrideProvider(ASSISTANT_ENABLED)
        .useValue(false)
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
    otherSiteId = (await createSite(prisma, 'Sede Sur')).id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', {
      siteId,
    });
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', {
        siteId,
      })
    ).token;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    grant: { siteId: string | null },
  ): Promise<{ token: string; practitionerId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({
      data: { userId: user.id },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grant.siteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
    };
  }

  const send = (
    method: 'get' | 'post',
    path: string,
    token: string,
    body?: object,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const historyOf = (patientId: string, token = doctorToken) =>
    send('get', `/patients/${patientId}/clinical-history`, token);

  async function theScene() {
    const exams = await seedExams(prisma);
    await aTariffConcept(prisma, { code: GLUCOSE_MSP_CODE });
    const orders = new PrismaServiceOrderRepository(
      prisma as unknown as PrismaService,
    );
    const reports = app.get(DiagnosticReportService, { strict: false });
    const everywhere = { userId: (await createUser(prisma)).id, sites: 'all' as const }; // prettier-ignore

    const survivor = await createPatient(prisma);
    const duplicate = await createPatient(prisma);

    const attention = (patientId: string, daysAgo: number, site = siteId) =>
      createEncounter(prisma, {
        siteId: site,
        practitionerId: doctorPractitionerId,
        patientId,
        startedAt: new Date(Date.now() - daysAgo * DAY),
      });

    /** A glucose registered by the orders service, `daysAgo` days back. */
    async function glucose(
      encounterId: string,
      daysAgo: number,
      value: number,
    ) {
      const order = await placeIssued(orders, {
        encounterId,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ serviceId: exams.glucose.id }],
        sites: 'all',
      });
      const report = await reports.register(
        {
          orderId: order.id,
          performedById: null,
          issuedAt: new Date(Date.now() - daysAgo * DAY + 3_600_000),
          results: [{ analyteDefinitionId: exams.glu.id, valueNumeric: value }],
        },
        everywhere,
      );
      return { order, report };
    }

    const first = await attention(survivor.id, 20);
    const corrected = await glucose(first.id, 20, 150);
    await reports.correct(
      {
        reportId: corrected.report.id,
        performedById: null,
        issuedAt: new Date(Date.now() - 19 * DAY),
        results: [{ analyteDefinitionId: exams.glu.id, valueNumeric: 182 }],
      },
      everywhere,
    );

    // ORD-152. A cancelled report says nothing, whatever its rows hold.
    const withdrawn = await glucose(first.id, 18, 61);
    await prisma.diagnosticReport.update({
      where: { id: withdrawn.report.id },
      data: { status: 'CANCELLED' },
    });

    const ofDuplicate = await attention(duplicate.id, 10);
    const normal = await glucose(ofDuplicate.id, 10, 92);

    const elsewhere = await attention(survivor.id, 6, otherSiteId);
    const outside = await glucose(elsewhere.id, 6, 300);

    const annulled = await attention(survivor.id, 2);
    const ofAnnulled = await glucose(annulled.id, 2, 45);
    await send(
      'post',
      `/encounters/${annulled.id}/enter-in-error`,
      doctorToken,
      {
        reason: 'Se abrió a otro paciente',
      },
    ).expect(200);

    const base = { siteId, prescriberId: doctorPractitionerId };
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY);
    const rxLine = (genericName: string, durationDays: number) => ({
      genericName,
      concentration: '10 mg',
      presentation: 'Tableta',
      doseText: '1 tableta',
      frequencyText: 'Cada 12 horas',
      durationDays,
      offFormulary: true,
    });
    await createIssuedPrescription(prisma, {
      ...base,
      encounterId: first.id,
      issuedAt: twentyDaysAgo,
      items: { create: [rxLine('Enalapril', 30), rxLine('Amoxicilina', 7)] },
    });
    const cancelledRx = await createIssuedPrescription(prisma, {
      ...base,
      encounterId: first.id,
      issuedAt: twentyDaysAgo,
      status: 'CANCELLED',
      items: { create: [rxLine('Ibuprofeno', 5)] },
    });

    await app
      .get(PatientMergeService, { strict: false })
      .merge(
        { sourcePatientId: duplicate.id, targetPatientId: survivor.id },
        { userId: (await createUser(prisma)).id },
      );

    return {
      survivor,
      duplicate,
      corrected,
      withdrawn,
      normal,
      outside,
      ofAnnulled,
      cancelledRx,
    };
  }

  it('AS-200 AS-201 sirve los resultados vigentes de la ficha y de la que absorbió, de sus sedes y sin la atención anulada', async () => {
    const scene = await theScene();

    const body = (await historyOf(scene.survivor.id).expect(200))
      .body as HistoryBody;

    expect(body.patientId).toBe(scene.survivor.id);
    expect(body.results.items.map((r) => [r.orderId, r.valueNumeric, r.fromMergedChart])).toEqual([
      [scene.normal.order.id, 92, true],
      [scene.corrected.order.id, 182, false],
    ]); // prettier-ignore
    expect(body.results.total).toBe(2);
    expect(body.hasEntriesOutsideScope).toBe(true);

    // Control positivo: lo excluido está en la base.
    const rows = await prisma.observationResult.findMany({
      select: { valueNumeric: true },
    });
    expect(rows.map((r) => Number(r.valueNumeric)).sort((a, b) => a - b)).toEqual([45, 61, 92, 150, 182, 300]); // prettier-ignore
  });

  it('AS-200 la sede que quien llama no atiende la ve quien tiene la clínica entera', async () => {
    const scene = await theScene();
    const clinicWide = await signIn('MEDICO', 'direccion@clinica.ec', '1104637283', { siteId: null }); // prettier-ignore

    const wide = (await historyOf(scene.survivor.id, clinicWide.token).expect(200))
      .body as HistoryBody; // prettier-ignore
    expect(wide.results.items.map((r) => r.orderId)).toContain(scene.outside.order.id); // prettier-ignore
    expect(wide.results.total).toBe(3);
    expect(wide.hasEntriesOutsideScope).toBe(false);
  });

  it('AS-202 SC-098 trae el valor, la unidad, el rango y la bandera del informe vigente de su orden', async () => {
    const scene = await theScene();
    const body = (await historyOf(scene.survivor.id).expect(200))
      .body as HistoryBody;

    expect(body.results.items.length).toBeGreaterThan(0);
    for (const result of body.results.items) {
      const reported = (
        await send('get', `/orders/${result.orderId}/reports`, doctorToken).expect(200)
      ).body as { items: { supersededById: string | null; status: string; results: ResultBody[] }[] }; // prettier-ignore
      const current = reported.items.filter(
        (report) =>
          report.supersededById === null && report.status !== 'CANCELLED',
      );
      const same = current
        .flatMap((report) => report.results)
        .find((row) => String(row.id) === result.id);
      expect(same).toBeDefined();
      for (const field of ['analyteDisplay', 'valueNumeric', 'unit', 'referenceLow', 'referenceHigh', 'referenceText', 'abnormalFlag'] as const) {
        expect([field, result[field]]).toEqual([field, same![field]]);
      } // prettier-ignore
    }
    const high = body.results.items.find((r) => r.valueNumeric === 182);
    expect(high).toMatchObject({ abnormalFlag: 'HIGH', referenceLow: 70, referenceHigh: 100 }); // prettier-ignore
    // AS-206. The same determination and unit, one series.
    expect(new Set(body.results.items.map((r) => r.seriesKey)).size).toBe(1);
  });

  it('AS-203 AS-204 trae cada medicamento emitido con su estado, y nada de la receta anulada', async () => {
    const scene = await theScene();
    const body = (await historyOf(scene.survivor.id).expect(200))
      .body as HistoryBody;

    expect(body.medications.items.map((m) => [m.genericName, m.status])).toEqual([
      ['Enalapril', 'ACTIVE'],
      ['Amoxicilina', 'ENDED'],
    ]); // prettier-ignore
    expect(body.medications.prescriptionTotal).toBe(1);
    // Control positivo: la anulada existe, con su línea.
    await expect(
      prisma.prescriptionItem.count({ where: { prescriptionId: scene.cancelledRx.id } }),
    ).resolves.toBe(1); // prettier-ignore
  });

  it('AS-205 escribe en la línea de tiempo las visitas y el resultado fuera de rango, no el normal', async () => {
    const scene = await theScene();
    const body = (await historyOf(scene.survivor.id).expect(200))
      .body as HistoryBody;

    const items = body.timeline.flatMap((day) => day.items);
    const high = body.results.items.find((r) => r.valueNumeric === 182)!;
    const normal = body.results.items.find((r) => r.valueNumeric === 92)!;
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'result', resultId: high.id }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ kind: 'result', resultId: normal.id }),
    );
    // The survivor's first attention and the duplicate's; not the annulled one.
    expect(items.filter((item) => item.kind === 'visit')).toHaveLength(2);
    expect(body.visits.total).toBe(2);
    expect(scene.ofAnnulled.order.id).toBeDefined();
  });

  it('AS-200 AS-207 deja una sola fila de bitácora por lectura, y ninguna para una ficha absorbida', async () => {
    const scene = await theScene();
    const rows = () =>
      prisma.accessAudit.count({
        where: { resourceType: 'patient_clinical_history' },
      });

    await historyOf(scene.survivor.id).expect(200);
    await expect(rows()).resolves.toBe(1);

    const refused = await historyOf(scene.duplicate.id).expect(409);
    expect((refused.body as { code: string }).code).toBe(
      'CLINICAL_HISTORY_CHART_NOT_OPEN',
    );
    await expect(rows()).resolves.toBe(1);
  });

  it('AS-200 responde con el asistente apagado, y pide record:read', async () => {
    const patient = await createPatient(prisma);
    // Control positivo: el interruptor está apagado en esta aplicación.
    await send('get', `/encounters/${patient.id}/assistant/diagnoses`, doctorToken).expect(404); // prettier-ignore

    await historyOf(patient.id).expect(200);
    await historyOf(patient.id, receptionToken).expect(403);
  });
});
