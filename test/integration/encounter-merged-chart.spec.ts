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
import { BackgroundSnapshotReader } from '../../src/modules/encounter/application/background-snapshot.reader';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createPatient,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * EN-237 (D-169.2 b) — the attention of a chart that admissions merged while
 * the consultation was still open.
 *
 * THE SCENE. The duplicate D has an OPEN attention; admissions merges D into
 * the real chart S, which holds a HIGH allergy, a personal history entry and
 * an earlier attention. The merge does not look at attentions, so D's stays
 * open, and the doctor keeps working in it. `chartScope(D)` reads down and
 * never up: the band, the summary behind the prescription tab and the
 * snapshot frozen into the signed note said nothing about S — while the
 * prescription, since PR-118, already blocked on S's allergy.
 *
 * THE MERGE IS THE REAL ONE (`PatientMergeService` out of the application's
 * own container), not an `UPDATE` by hand: what is shown is that the path
 * admissions uses leaves the attention in this state, and what the screen
 * reads from it afterwards.
 *
 * CONTROL POSITIVO in every case: the same scene without the merge, where S
 * is somebody else and nothing of hers may be read from D's attention.
 */
const PASSWORD = 'el caballo come alfalfa';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface AllergyBody {
  id: string;
  patientId: string;
  substanceText: string;
}

interface EncounterDetailBody {
  id: string;
  patientId: string;
  allergies: AllergyBody[];
  mergedInto: { patientId: string; mrn: string } | null;
}

interface ChartSummaryBody {
  allergies: AllergyBody[];
  noKnownAllergies: { assertedByName: string } | null;
  history: { description: string }[];
  previousEncounters: { id: string }[];
  totalEncounters: number;
}

describe('EN-237 la atención de una ficha que se unificó con la consulta abierta', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // The store and not the guard, as in `encounter-chart-summary`: the
        // authorisation guard is part of what is exercised.
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
    const doctor = await signInAsDoctor();
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** A MEDICO granted at the site, with a real session. Synthetic cédula. */
  async function signInAsDoctor(): Promise<{
    token: string;
    practitionerId: string;
  }> {
    const email = 'medico@clinica.ec';
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula: '1710034065',
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
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
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

  const post = (path: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send(body ?? {});

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${doctorToken}`);

  /** Derived from the clock, never typed: `agoMs` before now. */
  const openEncounter = async (
    patientId: string,
    agoMs: number,
  ): Promise<string> => {
    const response = await post('/encounters', {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: new Date(Date.now() - agoMs).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    return (response.body as { id: string }).id;
  };

  const merge = async (sourceId: string, targetId: string) =>
    app
      .get(PatientMergeService, { strict: false })
      .merge(
        { sourcePatientId: sourceId, targetPatientId: targetId },
        { userId: (await createUser(prisma)).id },
      );

  /**
   * D with its attention open; S with a HIGH allergy, a personal history
   * entry and an attention of her own from two days ago. Then, when asked,
   * the merge D → S.
   */
  async function theScene({ merged }: { merged: boolean }) {
    const duplicate = await createPatient(prisma);
    const survivor = await createPatient(prisma);
    const encounterId = await openEncounter(duplicate.id, MINUTE);
    const earlierOfSurvivor = await openEncounter(survivor.id, 2 * DAY);

    await post(`/patients/${survivor.id}/allergies`, {
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    }).expect(201);
    await post(`/patients/${survivor.id}/history`, {
      kind: 'PERSONAL',
      description: 'Diabetes tipo 2',
    }).expect(201);

    if (merged) await merge(duplicate.id, survivor.id);

    return { duplicate, survivor, encounterId, earlierOfSurvivor };
  }

  describe('la apertura de la atención (EN-081)', () => {
    it('EN-237 trae la alergia de la superviviente y dice en qué ficha se unificó', async () => {
      const { duplicate, survivor, encounterId } = await theScene({
        merged: true,
      });

      // La premisa de D-169.2, comprobada y no supuesta.
      const absorbed = await prisma.patient.findUniqueOrThrow({
        where: { id: duplicate.id },
        select: { mergedIntoId: true },
      });
      expect(absorbed.mergedIntoId).toBe(survivor.id);

      const body = (await get(`/encounters/${encounterId}`).expect(200))
        .body as EncounterDetailBody;

      expect(body.patientId).toBe(duplicate.id);
      expect(body.allergies.map((a) => a.substanceText)).toEqual([
        'Penicilina',
      ]);
      expect(body.allergies[0]?.patientId).toBe(survivor.id);
      expect(body.mergedInto).toEqual({
        patientId: survivor.id,
        mrn: survivor.mrn,
      });
    });

    it('EN-237 control positivo: sin la fusión la otra ficha es otra persona y no se lee nada de ella', async () => {
      const { encounterId } = await theScene({ merged: false });

      const body = (await get(`/encounters/${encounterId}`).expect(200))
        .body as EncounterDetailBody;

      expect(body.allergies).toEqual([]);
      expect(body.mergedInto).toBeNull();
    });

    it('EN-237 la atención abierta en la superviviente no se declara fusionada y ve la alergia de la absorbida', async () => {
      // La dirección de siempre (PA-055), que este cambio no puede romper.
      const duplicate = await createPatient(prisma);
      const survivor = await createPatient(prisma);
      await post(`/patients/${duplicate.id}/allergies`, {
        substanceText: 'Látex',
        criticality: 'LOW',
      }).expect(201);
      await merge(duplicate.id, survivor.id);
      const encounterId = await openEncounter(survivor.id, MINUTE);

      const body = (await get(`/encounters/${encounterId}`).expect(200))
        .body as EncounterDetailBody;

      expect(body.allergies.map((a) => a.substanceText)).toEqual(['Látex']);
      expect(body.mergedInto).toBeNull();
    });
  });

  describe('el resumen de la historia que leen la banda y la receta (EN-159)', () => {
    it('EN-237 lista la alergia, el antecedente y la atención anterior de la superviviente', async () => {
      const { encounterId, earlierOfSurvivor } = await theScene({
        merged: true,
      });

      const body = (
        await get(`/encounters/${encounterId}/chart-summary`).expect(200)
      ).body as ChartSummaryBody;

      expect(body.allergies.map((a) => a.substanceText)).toEqual([
        'Penicilina',
      ]);
      expect(body.history.map((h) => h.description)).toEqual([
        'Diabetes tipo 2',
      ]);
      expect(body.previousEncounters.map((e) => e.id)).toEqual([
        earlierOfSurvivor,
      ]);
      expect(body.totalEncounters).toBe(1);
    });

    it('EN-237 control positivo: sin la fusión el resumen no lleva nada de la otra ficha', async () => {
      const { encounterId } = await theScene({ merged: false });

      const body = (
        await get(`/encounters/${encounterId}/chart-summary`).expect(200)
      ).body as ChartSummaryBody;

      expect(body.allergies).toEqual([]);
      expect(body.history).toEqual([]);
      expect(body.previousEncounters).toEqual([]);
      expect(body.totalEncounters).toBe(0);
    });

    it('EN-237 EN-087 no sirve «sin alergias conocidas» de la superviviente en la atención absorbida, como la receta', async () => {
      // D-169.2: la afirmación se hizo sobre S, no en esta atención; el lado
      // seguro es «no registradas», lo mismo que imprime la receta (PR-117).
      const duplicate = await createPatient(prisma);
      const survivor = await createPatient(prisma);
      const encounterId = await openEncounter(duplicate.id, MINUTE);
      const survivorEncounterId = await openEncounter(survivor.id, MINUTE);
      await post(`/patients/${survivor.id}/allergies/none-known`).expect(201);
      await merge(duplicate.id, survivor.id);

      const absorbed = (
        await get(`/encounters/${encounterId}/chart-summary`).expect(200)
      ).body as ChartSummaryBody;
      expect(absorbed.allergies).toEqual([]);
      expect(absorbed.noKnownAllergies).toBeNull();

      // Control positivo: en la atención de la propia superviviente, sí.
      const own = (
        await get(`/encounters/${survivorEncounterId}/chart-summary`).expect(
          200,
        )
      ).body as ChartSummaryBody;
      expect(own.noKnownAllergies?.assertedByName).toBe('Ana Villacís');
    });
  });

  describe('la propuesta de «subsecuente», la bitácora y deshacer la fusión', () => {
    it('EN-237 EN-184 propone «subsecuente» por un diagnóstico de la misma categoría en la superviviente', async () => {
      const { duplicate, survivor, encounterId, earlierOfSurvivor } =
        await theScene({ merged: false });
      await createDiagnosis(prisma, earlierOfSurvivor, 'E11.9');
      const concept = await prisma.catalogConcept.findFirstOrThrow({
        where: { code: 'E11.9' },
      });
      const propose = async () =>
        (
          await get(
            `/encounters/${encounterId}/diagnoses/occurrence-proposal?conceptId=${concept.id}`,
          ).expect(200)
        ).body as { proposed: string };

      // Control positivo: sin unificar, la diabetes es de otra persona.
      expect((await propose()).proposed).toBe('FIRST_TIME');

      await merge(duplicate.id, survivor.id);
      expect((await propose()).proposed).toBe('SUBSEQUENT');
    });

    it('EN-237 EN-161 leer el resumen deja una fila de bitácora sobre la ficha que divulgó: la superviviente', async () => {
      const { survivor, duplicate, encounterId } = await theScene({
        merged: true,
      });
      const rows = (resourceId: string) =>
        prisma.accessAudit.count({
          where: { resourceType: 'patient_chart_summary', resourceId },
        });

      await get(`/encounters/${encounterId}/chart-summary`).expect(200);

      expect(await rows(survivor.id)).toBe(1);
      expect(await rows(duplicate.id)).toBe(0);
    });

    it('EN-237 al deshacer la fusión la atención vuelve a leer solo su ficha', async () => {
      const { duplicate, encounterId } = await theScene({ merged: true });
      const opened = async () =>
        (await get(`/encounters/${encounterId}`).expect(200))
          .body as EncounterDetailBody;
      // Control positivo: unificada, lee la vigente.
      expect((await opened()).allergies).toHaveLength(1);

      await app
        .get(PatientMergeService, { strict: false })
        .undo(
          { sourcePatientId: duplicate.id },
          { userId: (await createUser(prisma)).id },
        );

      const after = await opened();
      expect(after.allergies).toEqual([]);
      expect(after.mergedInto).toBeNull();
      const summary = (
        await get(`/encounters/${encounterId}/chart-summary`).expect(200)
      ).body as ChartSummaryBody;
      expect(summary.allergies).toEqual([]);
      expect(summary.history).toEqual([]);
      expect(summary.previousEncounters).toEqual([]);
    });
  });

  describe('la foto de antecedentes que se congela al firmar (EN-206)', () => {
    it('EN-237 EN-206 la instantánea de la atención absorbida lleva la alergia y el antecedente de la superviviente', async () => {
      const { duplicate } = await theScene({ merged: true });

      const snapshot = await app
        .get(BackgroundSnapshotReader, { strict: false })
        .snapshotOf(duplicate.id, new Date());

      expect(snapshot.allergies.map((a) => a.substance)).toEqual([
        'Penicilina',
      ]);
      expect(snapshot.personalHistory.map((h) => h.description)).toEqual([
        'Diabetes tipo 2',
      ]);
    });

    it('EN-237 EN-206 control positivo: sin la fusión la instantánea no lleva nada de la otra ficha', async () => {
      const { duplicate } = await theScene({ merged: false });

      const snapshot = await app
        .get(BackgroundSnapshotReader, { strict: false })
        .snapshotOf(duplicate.id, new Date());

      expect(snapshot.allergies).toEqual([]);
      expect(snapshot.personalHistory).toEqual([]);
    });
  });
});
