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
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * EN-269 to EN-272 — `GET /patients/:id/vitals`, against a real PostgreSQL 18
 * and with real sessions.
 *
 * THE SCENE. The survivor S has two takings at the doctor's site (one of them
 * on an attention later annulled) and one at a site the doctor does not
 * cover; the duplicate D, merged into S, has one more. The doctor sees S's
 * valid one and D's — and nothing else.
 *
 * CONTROL POSITIVO in every refusal: a doctor granted at clinic level reads
 * the other site's taking through the same route, and the annulled taking is
 * still in the table.
 */
const PASSWORD = 'el caballo come alfalfa';
const HOUR = 3_600_000;

interface TakingBody {
  encounterId: string;
  siteId: string;
  measuredAt: string;
  ageYears: number | null;
  weightKg: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  bmi: number | null;
}

interface VitalsHistoryBody {
  patientId: string;
  items: TakingBody[];
  total: number;
  bloodPressureReference: { systolic: number; diastolic: number } | null;
}

describe('la evolución de los signos por HTTP', () => {
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

  /** One account with one role, at one site or (`siteId: null`) the clinic. */
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
    method: 'get' | 'post' | 'put',
    path: string,
    token: string,
    body?: object,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const vitalsOf = (patientId: string, token = doctorToken) =>
    send('get', `/patients/${patientId}/vitals`, token);

  /** An attention at the doctor's site, `agoMs` before now, with its taking. */
  async function attendedWith(
    patientId: string,
    agoMs: number,
    taking: object,
  ): Promise<string> {
    const opened = await send('post', '/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: new Date(Date.now() - agoMs).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    const encounterId = (opened.body as { id: string }).id;
    await send(
      'put',
      `/encounters/${encounterId}/vitals`,
      doctorToken,
      taking,
    ).expect(200);
    return encounterId;
  }

  async function theScene() {
    const survivor = await createPatient(prisma);
    const duplicate = await createPatient(prisma);

    const kept = await attendedWith(survivor.id, 3 * HOUR, {
      weightKg: 70,
      systolicBp: 128,
      diastolicBp: 82,
    });
    const annulled = await attendedWith(survivor.id, 2 * HOUR, {
      weightKg: 90,
    });
    await send('post', `/encounters/${annulled}/enter-in-error`, doctorToken, {
      reason: 'Se abrió a otro paciente',
    }).expect(200);
    const ofDuplicate = await attendedWith(duplicate.id, HOUR, {
      weightKg: 71,
    });

    // At a site the doctor does not cover: written straight to the tables,
    // as another site's nurse would have.
    const elsewhere = await createEncounter(prisma, {
      siteId: otherSiteId,
      practitionerId: (await createPractitioner(prisma)).id,
      patientId: survivor.id,
      startedAt: new Date(Date.now() - 4 * HOUR),
    });
    await prisma.encounterVitals.create({
      data: {
        encounterId: elsewhere.id,
        weightKg: 75,
        recordedById: (await createUser(prisma)).id,
      },
    });

    await app
      .get(PatientMergeService, { strict: false })
      .merge(
        { sourcePatientId: duplicate.id, targetPatientId: survivor.id },
        { userId: (await createUser(prisma)).id },
      );

    return { survivor, duplicate, kept, annulled, ofDuplicate, elsewhere };
  }

  it('EN-269 sirve las tomas de la ficha y de la que absorbió, de la más reciente a la más antigua, con la edad congelada', async () => {
    const { survivor, kept, ofDuplicate } = await theScene();

    const body = (await vitalsOf(survivor.id).expect(200))
      .body as VitalsHistoryBody;

    expect(body.patientId).toBe(survivor.id);
    expect(body.items.map((taking) => taking.encounterId)).toEqual([
      ofDuplicate,
      kept,
    ]);
    expect(body.total).toBe(2);
    expect(body.items[1]).toMatchObject({
      siteId,
      weightKg: 70,
      systolicBp: 128,
      diastolicBp: 82,
    });
    const frozen = await prisma.encounter.findUniqueOrThrow({
      where: { id: kept },
      select: { ageYears: true },
    });
    expect(frozen.ageYears).not.toBeNull();
    expect(body.items[1]?.ageYears).toBe(frozen.ageYears);
    // Sin el motivo de consulta: es texto, no una cifra que se dibuje.
    expect(body.items[1]).not.toHaveProperty('presentingComplaint');
  });

  it('EN-270 no sirve ni cuenta la toma de una atención anulada, que sigue en la tabla', async () => {
    const { survivor, annulled } = await theScene();

    const body = (await vitalsOf(survivor.id).expect(200))
      .body as VitalsHistoryBody;

    expect(body.items.map((taking) => taking.encounterId)).not.toContain(
      annulled,
    );
    expect(body.total).toBe(2);
    // Control positivo: la toma existe; lo que la deja fuera es la anulación.
    await expect(
      prisma.encounterVitals.count({ where: { encounterId: annulled } }),
    ).resolves.toBe(1);
  });

  it('EN-269 deja fuera la sede que quien llama no atiende, y la ve quien tiene la clínica entera', async () => {
    const { survivor, elsewhere } = await theScene();

    const local = (await vitalsOf(survivor.id).expect(200))
      .body as VitalsHistoryBody;
    expect(local.items.map((taking) => taking.encounterId)).not.toContain(
      elsewhere.id,
    );

    const clinicWide = await signIn(
      'MEDICO',
      'direccion@clinica.ec',
      '1104637283',
      { siteId: null },
    );
    const wide = (await vitalsOf(survivor.id, clinicWide.token).expect(200))
      .body as VitalsHistoryBody;
    expect(wide.items.map((taking) => taking.encounterId)).toContain(
      elsewhere.id,
    );
    expect(wide.total).toBe(3);
  });

  it('EN-271 deja una sola fila de bitácora por lectura, y ninguna para una ficha absorbida', async () => {
    const { survivor, duplicate } = await theScene();
    const rows = () =>
      prisma.accessAudit.count({
        where: { resourceType: 'patient_vitals_history' },
      });

    await vitalsOf(survivor.id).expect(200);
    await expect(rows()).resolves.toBe(1);

    const refused = await vitalsOf(duplicate.id).expect(409);
    expect((refused.body as { code: string }).code).toBe(
      'PATIENT_CHART_NOT_OPEN',
    );
    await expect(rows()).resolves.toBe(1);
  });

  it('EN-272 trae la línea de la TA de la sede, la más baja si el alcance tiene varias', async () => {
    const { survivor } = await theScene();

    const initial = (await vitalsOf(survivor.id).expect(200))
      .body as VitalsHistoryBody;
    expect(initial.bloodPressureReference).toEqual({
      systolic: 140,
      diastolic: 90,
    });

    // La otra sede baja su línea: no es del alcance del médico de la sede.
    await prisma.siteParameter.update({
      where: { siteId: otherSiteId },
      data: { bpReferenceSystolic: 130, bpReferenceDiastolic: 80 },
    });
    const unchanged = (await vitalsOf(survivor.id).expect(200))
      .body as VitalsHistoryBody;
    expect(unchanged.bloodPressureReference).toEqual({
      systolic: 140,
      diastolic: 90,
    });

    const clinicWide = await signIn(
      'MEDICO',
      'direccion@clinica.ec',
      '1104637283',
      { siteId: null },
    );
    const wide = (await vitalsOf(survivor.id, clinicWide.token).expect(200))
      .body as VitalsHistoryBody;
    expect(wide.bloodPressureReference).toEqual({
      systolic: 130,
      diastolic: 80,
    });
  });

  it('EN-269 recepción, sin `record:read`, no lee los signos', async () => {
    const { survivor } = await theScene();
    await vitalsOf(survivor.id, receptionToken).expect(403);
    // Control positivo: el médico de la misma sede sí.
    await vitalsOf(survivor.id).expect(200);
  });
});
