import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedRdacaa } from '../../prisma/seed-rdacaa.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Blocks G, H and I through the HTTP door, with REAL SESSIONS of the seeded
 * roles (EN-090 to EN-093, EN-097, EN-249): `MEDICO` writes all three and
 * holds the second key; `ENFERMERIA` writes H and I (`vitals:write`) and not
 * G, and does not hold the key — so it neither reads nor writes the risk
 * group of an adult hepatitis B (REQ-115).
 */
const PASSWORD = 'el caballo come alfalfa';

const OBSTETRIC = {
  risk: 'HIGH',
  birthPlan: true,
  transportPlan: true,
  plannedPregnancy: false,
  gestationalAgeMethod: 'ULTRASOUND',
  gestationalWeeks: 24,
  nonTreponemalTest: 'NEGATIVE',
  bacteriuria: 'NOT_DONE',
};

describe('los bloques de programa por HTTP, con sesiones reales (EN-090 a EN-093, EN-249)', () => {
  const db = useDatabase();
  let app: NestExpressApplication | undefined;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let nurseToken: string;
  let elsewhereDoctorToken: string;
  let otherSiteId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // The STORE and not the guard: `APP_GUARD` also carries the
        // authorisation guard, which is what this file is about.
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

    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
    otherSiteId = otherSite.id;
    await seedRdacaa(prisma);

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', siteId); // prettier-ignore
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId;
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283', siteId)).token; // prettier-ignore
    // A doctor whose key and record:read are at ANOTHER site (EN-121).
    elsewhereDoctorToken = (await signIn('MEDICO', 'medico3@clinica.ec', '0926687856', otherSite.id)).token; // prettier-ignore
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** One account with one seeded role, granted at one site. */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    atSite: string,
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
      data: { userId: user.id, roleId: role.id, siteId: atSite },
    });

    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
    };
  }

  /**
   * An account whose permissions are split across sites, through roles of the
   * clinic's own (roles are data): what makes the site scope of the second
   * key checkable at all.
   */
  async function signInSplit(
    email: string,
    cedula: string,
    grants: { permissions: string[]; siteId: string }[],
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Luis',
        lastName: 'Andrade',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.practitioner.create({ data: { userId: user.id } });
    for (const [index, grant] of grants.entries()) {
      const role = await prisma.role.create({
        data: {
          code: `PROPIO_${index}_${cedula}`,
          name: `Rol propio ${index}`,
          permissions: {
            create: grant.permissions.map((permissionCode) => ({ permissionCode })), // prettier-ignore
          },
        },
      });
      await prisma.userRoleGrant.create({
        data: { userId: user.id, roleId: role.id, siteId: grant.siteId },
      });
    }
    registry.invalidate();
    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const send = (
    method: 'get' | 'post' | 'put',
    path: string,
    token: string,
    body?: object,
  ) => {
    const call = request(app!.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? call : call.send(body);
  };

  async function openEncounter(patientId: string): Promise<string> {
    const response = await send('post', '/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    return (response.body as { id: string }).id;
  }

  /** The clinical date of the attentions these tests open, and days from it. */
  function around(days: number): Date {
    const [y, m, d] = clinicalDateOf(new Date(Date.now() - 3_600_000))
      .split('-')
      .map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + days));
  }

  /** A patient born `months` (and `years`) before the clinical date. */
  async function aPatient(
    age: { years?: number; months?: number },
    sex?: 'MALE' | 'FEMALE',
  ) {
    const [y, m, d] = clinicalDateOf(new Date(Date.now() - 3_600_000))
      .split('-')
      .map(Number) as [number, number, number];
    const patient = await createPatient(prisma, {
      sex,
      birthDate: new Date(
        Date.UTC(y - (age.years ?? 0), m - 1 - (age.months ?? 0), d),
      ),
    });
    return patient.id;
  }

  async function pregnantPatient(): Promise<string> {
    const patientId = await aPatient({ years: 27 });
    const nurse = await prisma.user.findUniqueOrThrow({ where: { email: 'enfermeria@clinica.ec' } }); // prettier-ignore
    await prisma.patientPriorityGroup.create({
      data: {
        patientId,
        groupCode: 'PREGNANT',
        startsOn: around(-160),
        endsOn: around(120),
        origin: 'SELF_DECLARED',
        recordedById: nurse.id,
      },
    });
    return patientId;
  }

  const programs = async (encounterId: string, token: string) =>
    (
      await send('get', `/encounters/${encounterId}/programs`, token).expect(
        200,
      )
    ).body as {
      clinicalDate: string;
      obstetric: { applies: boolean; record: Record<string, unknown> | null };
      nutrition: {
        band: string | null;
        record: Record<string, unknown> | null;
      };
      vaccination: {
        vaccines: { code: string; display: string }[];
        record: { doses: unknown[]; riskGroup: string | null } | null;
        riskGroupWithheld: boolean;
      };
    };

  const trailOf = (encounterId: string, action: string) =>
    prisma.accessAudit.count({
      where: {
        resourceType: 'encounter_program',
        resourceId: encounterId,
        action,
      },
    });

  describe('EN-090 EN-091 el bloque obstétrico', () => {
    it('EN-090 EN-097 a la embarazada se le ofrece y se registra; a quien no lo está, ni se ofrece ni entra', async () => {
      const pregnant = await openEncounter(await pregnantPatient());
      const other = await openEncounter(await aPatient({ years: 40 }));

      expect((await programs(pregnant, doctorToken)).obstetric).toEqual({ applies: true, record: null }); // prettier-ignore
      expect((await programs(other, doctorToken)).obstetric).toEqual({ applies: false, record: null }); // prettier-ignore

      const refused = await send('put', `/encounters/${other}/programs/obstetric`, doctorToken, OBSTETRIC).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({
        code: 'PROGRAM_BLOCK_NOT_APPLICABLE',
      });

      // Positive control: the same answer on the pregnant patient.
      const saved = await send('put', `/encounters/${pregnant}/programs/obstetric`, doctorToken, OBSTETRIC).expect(200); // prettier-ignore
      expect(saved.body).toMatchObject({
        ...OBSTETRIC,
        lastMenstrualPeriod: null,
        treponemalTest: null,
        editedAt: null,
      });
      expect((await programs(pregnant, doctorToken)).obstetric.record).toMatchObject({ risk: 'HIGH' }); // prettier-ignore
    });

    it('EN-090 enfermería no registra el riesgo obstétrico (403); el médico sí', async () => {
      const encounterId = await openEncounter(await pregnantPatient());
      await send('put', `/encounters/${encounterId}/programs/obstetric`, nurseToken, OBSTETRIC).expect(403); // prettier-ignore
      await send('put', `/encounters/${encounterId}/programs/obstetric`, doctorToken, OBSTETRIC).expect(200); // prettier-ignore
    });

    it('EN-090 la FUM posterior a la atención se nombra en su campo; la de hace diez semanas entra con el método FUM', async () => {
      const encounterId = await openEncounter(await pregnantPatient());
      const future = around(2).toISOString().slice(0, 10);
      const refused = await send('put', `/encounters/${encounterId}/programs/obstetric`, doctorToken, { ...OBSTETRIC, gestationalAgeMethod: 'LMP', lastMenstrualPeriod: future }).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ field: 'lastMenstrualPeriod' })] }); // prettier-ignore

      const lmp = around(-70).toISOString().slice(0, 10);
      const saved = await send('put', `/encounters/${encounterId}/programs/obstetric`, doctorToken, { ...OBSTETRIC, gestationalAgeMethod: 'LMP', lastMenstrualPeriod: lmp, gestationalWeeks: 10 }).expect(200); // prettier-ignore
      expect(saved.body).toMatchObject({
        lastMenstrualPeriod: lmp,
        gestationalWeeks: 10,
      });
    });
  });

  describe('EN-249 corregir es editar', () => {
    it('EN-249 la corrección guarda la versión anterior, deja su fila de bitácora, y repetir lo mismo no escribe nada', async () => {
      const encounterId = await openEncounter(await pregnantPatient());
      const url = `/encounters/${encounterId}/programs/obstetric`;
      await send('put', url, doctorToken, OBSTETRIC).expect(200);
      await send('put', url, doctorToken, OBSTETRIC).expect(200);
      expect(await prisma.recordVersion.count({ where: { resourceType: 'encounter_obstetric' } })).toBe(0); // prettier-ignore

      const corrected = await send('put', url, doctorToken, { ...OBSTETRIC, risk: 'IMMINENT' }).expect(200); // prettier-ignore
      expect(
        (corrected.body as { editedAt: string | null }).editedAt,
      ).not.toBeNull();
      expect(await prisma.recordVersion.count({ where: { resourceType: 'encounter_obstetric', resourceId: encounterId } })).toBe(1); // prettier-ignore
      expect(await trailOf(encounterId, 'CREATE')).toBe(1);
      expect(await trailOf(encounterId, 'UPDATE')).toBe(1);
    });

    it('EN-249 con la atención de alta no se corrige: 409 ENCOUNTER_ALREADY_CLOSED', async () => {
      const encounterId = await openEncounter(await aPatient({ months: 3 }));
      const answer = {
        motherBreastfeeding: true,
        exclusiveBreastfeeding: true,
      };
      // Positive control: live, it goes in.
      await send('put', `/encounters/${encounterId}/programs/nutrition`, nurseToken, answer).expect(200); // prettier-ignore
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCHARGED', endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });
      const refused = await send('put', `/encounters/${encounterId}/programs/nutrition`, nurseToken, { ...answer, motherBreastfeeding: false }).expect(409); // prettier-ignore
      expect(refused.body).toMatchObject({ code: 'ENCOUNTER_ALREADY_CLOSED' });
    });
  });

  describe('EN-092 el SIVAN', () => {
    it('EN-092 EN-097 a los 3 meses pregunta por la leche materna y enfermería lo registra; a los 2 años no se ofrece ni entra', async () => {
      const baby = await openEncounter(await aPatient({ months: 3 }));
      const toddler = await openEncounter(await aPatient({ years: 2 }));

      expect((await programs(baby, nurseToken)).nutrition).toEqual({ band: 'EXCLUSIVE_BREASTFEEDING', record: null }); // prettier-ignore
      expect((await programs(toddler, nurseToken)).nutrition.band).toBeNull();

      const answer = {
        motherBreastfeeding: true,
        exclusiveBreastfeeding: false,
      };
      const refused = await send('put', `/encounters/${toddler}/programs/nutrition`, nurseToken, answer).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({
        code: 'PROGRAM_BLOCK_NOT_APPLICABLE',
      });
      // The other band's question, at 3 months: not applicable either.
      await send('put', `/encounters/${baby}/programs/nutrition`, nurseToken, { motherBreastfeeding: true, complementaryFeeding: true }).expect(422); // prettier-ignore

      await send('put', `/encounters/${baby}/programs/nutrition`, nurseToken, answer).expect(200); // prettier-ignore
      expect((await programs(baby, doctorToken)).nutrition.record).toMatchObject({ ...answer, complementaryFeeding: null }); // prettier-ignore
    });

    it('EN-092 sin la pregunta de su tramo se nombra el campo', async () => {
      const encounterId = await openEncounter(await aPatient({ months: 7 }));
      const refused = await send('put', `/encounters/${encounterId}/programs/nutrition`, nurseToken, { motherBreastfeeding: false }).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ field: 'complementaryFeeding' })] }); // prettier-ignore
      await send('put', `/encounters/${encounterId}/programs/nutrition`, nurseToken, { motherBreastfeeding: false, complementaryFeeding: true }).expect(200); // prettier-ignore
    });
  });

  describe('EN-093 las vacunas', () => {
    it('EN-093 ofrece las 19 vacunas del día, y enfermería registra dT adulto con su grupo de riesgo', async () => {
      const encounterId = await openEncounter(await aPatient({ years: 30 }));
      const sheet = await programs(encounterId, nurseToken);
      expect(sheet.vaccination.vaccines).toHaveLength(19);
      expect(sheet.vaccination.vaccines[0]).toEqual({
        code: '55',
        display: 'BCG',
      });

      const url = `/encounters/${encounterId}/programs/vaccination`;
      const refused = await send('put', url, nurseToken, { doses: [{ code: '67', dose: 'SECOND' }], riskGroup: 'TRAVELLER' }).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ field: 'riskGroup' })] }); // prettier-ignore

      const saved = await send('put', url, nurseToken, { doses: [{ code: '67', dose: 'SECOND' }], riskGroup: 'AGES_AT_RISK' }).expect(200); // prettier-ignore
      expect(saved.body).toMatchObject({ doses: [{ code: '67', dose: 'SECOND' }], riskGroup: 'AGES_AT_RISK' }); // prettier-ignore
    });

    it('EN-093 EN-095 el grupo de riesgo del HB adulto: sin la llave ni se escribe ni se ve, sea cual sea; con ella, sí', async () => {
      const withHiv = await openEncounter(await aPatient({ years: 30 }));
      const worker = await openEncounter(await aPatient({ years: 30 }));
      const hb = (riskGroup: string) => ({
        doses: [{ code: '70', dose: 'FIRST' }],
        riskGroup,
      });

      const refused = await send('put', `/encounters/${withHiv}/programs/vaccination`, nurseToken, hb('HEALTH_WORKER')).expect(403); // prettier-ignore
      expect(refused.body).toMatchObject({
        code: 'PROTECTED_SECTION_REQUIRED',
      });
      expect(JSON.stringify({ ...(refused.body as object), instance: undefined })).not.toMatch(/VIH|HIV|sexual/i); // prettier-ignore

      // Positive control: the doctor holds the key.
      await send('put', `/encounters/${withHiv}/programs/vaccination`, doctorToken, hb('LIVING_WITH_HIV')).expect(200); // prettier-ignore
      await send('put', `/encounters/${worker}/programs/vaccination`, doctorToken, hb('HEALTH_WORKER')).expect(200); // prettier-ignore

      // Without the key, the two read the same: no oracle.
      const a = (await programs(withHiv, nurseToken)).vaccination;
      const b = (await programs(worker, nurseToken)).vaccination;
      expect(a.record?.riskGroup).toBeNull();
      expect(a.riskGroupWithheld).toBe(true);
      expect({ ...a.record, recordedAt: null }).toEqual({
        ...b.record,
        recordedAt: null,
      });
      expect(JSON.stringify(a)).not.toMatch(/LIVING_WITH_HIV/);

      // With it, each its own.
      expect((await programs(withHiv, doctorToken)).vaccination.record?.riskGroup).toBe('LIVING_WITH_HIV'); // prettier-ignore

      // Nor does the nurse overwrite what she was not shown.
      await send('put', `/encounters/${withHiv}/programs/vaccination`, nurseToken, { doses: [{ code: '55', dose: 'SINGLE' }], riskGroup: null }).expect(403); // prettier-ignore
      expect((await programs(withHiv, doctorToken)).vaccination.record?.riskGroup).toBe('LIVING_WITH_HIV'); // prettier-ignore
    });
  });

  describe('EN-121 la sede', () => {
    it('EN-090 una atención de otra sede es 404 para leer y para escribir', async () => {
      const encounterId = await openEncounter(await pregnantPatient());
      await send('get', `/encounters/${encounterId}/programs`, elsewhereDoctorToken).expect(404); // prettier-ignore
      await send('put', `/encounters/${encounterId}/programs/obstetric`, elsewhereDoctorToken, OBSTETRIC).expect(404); // prettier-ignore
      // Positive control: in scope it reads.
      await send('get', `/encounters/${encounterId}/programs`, doctorToken).expect(200); // prettier-ignore
    });
  });

  describe('EN-094 EN-095 EN-098 la prueba de VIH, con el régimen del tamizaje', () => {
    const REACTIVE = {
      reason: 'CLINICAL_SUSPICION',
      screening: { device: 'RAPID_FOURTH_GENERATION', result: 'REACTIVE' },
      confirmation: { device: 'ELISA', result: 'REACTIVE' },
      transmissionRoute: 'SEXUAL',
      viralLoad: 48_000,
      cd4: 310,
    };
    /** Words only an HIV test would put in a response. */
    const TELLTALES = ['CLINICAL_SUSPICION', 'RAPID_FOURTH_GENERATION', 'REACTIVE', 'SEXUAL', '48000']; // prettier-ignore
    const restricted = (id: string) => `/encounters/${id}/programs/restricted`;
    const reads = (encounterId: string) =>
      prisma.accessAudit.count({
        where: { resourceType: 'encounter_restricted_program', resourceId: encounterId, action: 'READ' }, // prettier-ignore
      });

    it('EN-095 enfermería recibe la omisión, la misma haya o no prueba, y sin fila de bitácora; el médico la ve con una', async () => {
      const tested = await openEncounter(await aPatient({ years: 30 }));
      const untested = await openEncounter(await aPatient({ years: 30 }));
      await send('put', restricted(tested), doctorToken, REACTIVE).expect(200);

      const a = await send('get', restricted(tested), nurseToken).expect(200);
      const b = await send('get', restricted(untested), nurseToken).expect(200);
      expect(a.body).toEqual({});
      expect(b.body).toEqual({});
      expect(await reads(tested)).toBe(0);

      // Positive control: the doctor sees it, and the read leaves ONE row.
      const seen = await send('get', restricted(tested), doctorToken).expect(
        200,
      );
      expect(seen.body).toMatchObject({ test: { reason: 'CLINICAL_SUSPICION', confirmation: { device: 'ELISA', result: 'REACTIVE' } } }); // prettier-ignore
      expect(await reads(tested)).toBe(1);
      expect((await send('get', restricted(untested), doctorToken).expect(200)).body).toEqual({ test: null }); // prettier-ignore
    });

    it('EN-095 enfermería no la registra (403) y el rechazo no nombra el dato', async () => {
      const encounterId = await openEncounter(await aPatient({ years: 30 }));
      const refused = await send('put', restricted(encounterId), nurseToken, REACTIVE).expect(403); // prettier-ignore
      expect(JSON.stringify({ ...(refused.body as object), instance: undefined })).not.toMatch(/VIH|HIV/i); // prettier-ignore
      expect(await prisma.encounterHivTest.count()).toBe(0);
    });

    it('EN-095 con record:read en la sede y la llave sólo en otra, la respuesta es la omisión', async () => {
      const encounterId = await openEncounter(await aPatient({ years: 30 }));
      await send('put', restricted(encounterId), doctorToken, REACTIVE).expect(
        200,
      );
      const token = await signInSplit('partida-vih@clinica.ec', '1701234567', [
        { permissions: ['record:read'], siteId },
        { permissions: ['record:protected', 'record:write', 'record:read'], siteId: otherSiteId }, // prettier-ignore
      ]);
      expect((await send('get', restricted(encounterId), token).expect(200)).body).toEqual({}); // prettier-ignore
      // Nor does it write: the two keys are not together at this site.
      await send('put', restricted(encounterId), token, REACTIVE).expect(404);
    });

    it('EN-094 la segunda prueba sin una primera reactiva no se registra, y se dice por qué', async () => {
      const encounterId = await openEncounter(await aPatient({ years: 30 }));
      const refused = await send('put', restricted(encounterId), doctorToken, { ...REACTIVE, screening: { device: 'ELISA', result: 'NON_REACTIVE' } }).expect(422); // prettier-ignore
      expect(refused.body).toMatchObject({
        code: 'CONFIRMATORY_TEST_WITHOUT_SCREENING',
      });
      await send('put', restricted(encounterId), doctorToken, REACTIVE).expect(
        200,
      );
    });

    it('EN-098 la prueba no viaja en el listado de atenciones, en la atención ni en sus bloques, ni con la llave', async () => {
      const patientId = await aPatient({ years: 30 });
      const encounterId = await openEncounter(patientId);
      await send('put', restricted(encounterId), doctorToken, REACTIVE).expect(
        200,
      );

      for (const path of [
        `/encounters?patientId=${patientId}`,
        `/encounters/open`,
        `/encounters/${encounterId}`,
        `/encounters/${encounterId}/programs`,
      ]) {
        const body = JSON.stringify((await send('get', path, doctorToken).expect(200)).body); // prettier-ignore
        for (const telltale of TELLTALES) expect(body).not.toContain(telltale);
      }
      // Positive control: the restricted door does carry it.
      const body = JSON.stringify((await send('get', restricted(encounterId), doctorToken).expect(200)).body); // prettier-ignore
      expect(body).toContain('CLINICAL_SUSPICION');
    });
  });
});
