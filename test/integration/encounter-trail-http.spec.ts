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
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createSite,
  hourSlot,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The attention's trail, place and keeping, as the browser consumes them
 * (encounter/H1, H2 — `feat/f04-atencion-y-nota`).
 *
 * WITH REAL SESSIONS, as `encounter-http.spec.ts`: the roles are the ones the
 * seed ships and the site scope is a real grant at one site. The instants are
 * derived from the clock, never typed.
 */
const PASSWORD = 'el caballo come alfalfa';
const MINUTE = 60_000;

const COMPLETE_002 = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

interface Change {
  from: string | null;
  to: string;
  fact: string;
  byName: string | null;
  at: string;
}

describe('la atención por HTTP: su historial, su lugar y su conservación', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let otherSiteId: string;
  let patientId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let receptionToken: string;
  let adminToken: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones, como en `encounter-http`: se sustituye el
        // ALMACÉN y no el guard, que también es el de autorización.
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
    patientId = (await createPatient(prisma)).id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId as string;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', false)
    ).token;
    adminToken = (
      await signIn('ADMIN', 'admin@clinica.ec', '1104637283', false)
    ).token;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** One account with one role at ONE site. Synthetic cédulas with check digit. */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    withPractitioner = true,
  ): Promise<{ token: string; practitionerId?: string }> {
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
    const practitioner = withPractitioner
      ? await prisma.practitioner.create({ data: { userId: user.id } })
      : undefined;
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
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner?.id,
    };
  }

  /** The real instant of an attention: some minutes ago, from the clock. */
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * MINUTE).toISOString();

  const openBody = (overrides: Record<string, unknown> = {}) => ({
    siteId,
    practitionerId: doctorPractitionerId,
    patientId,
    startedAt: minutesAgo(30),
    careModality: 'MORBIDITY',
    visitSequence: 'FIRST_TIME',
    ...overrides,
  });

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});
  const patch = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function openEncounter(
    token = doctorToken,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; [key: string]: unknown }> {
    const response = await post('/encounters', token, openBody(overrides));
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  async function signTheNote(encounterId: string): Promise<void> {
    const draft = await post(`/encounters/${encounterId}/notes`, doctorToken, {
      formCode: '002',
      content: COMPLETE_002,
    }).expect(201);
    await createDiagnosis(prisma, encounterId, 'J02.9');
    await post(
      `/encounters/${encounterId}/notes/${(draft.body as { id: string }).id}/sign`,
      doctorToken,
      { dischargeCondition: 'ALIVE' },
    ).expect(200);
  }

  const trailOf = async (encounterId: string, token = doctorToken) =>
    (
      (
        await get(`/encounters/${encounterId}/status-history`, token).expect(
          200,
        )
      ).body as { items: Change[] }
    ).items;

  describe('EN-127, EN-133 el historial de estados', () => {
    it('EN-127 EN-133 abrir deja la atención en OPEN y la primera fila dice quién la abrió y cuándo', async () => {
      const before = Date.now();
      const opened = await openEncounter(receptionToken);
      expect(opened.status).toBe('OPEN');

      const [first, ...rest] = await trailOf(opened.id);
      expect(rest).toHaveLength(0);
      expect(first).toMatchObject({
        from: null,
        to: 'OPEN',
        fact: 'OPENED',
        byName: 'Ana Villacís',
      });
      // El instante de la apertura, no el de la consulta (EN-034): ése es el
      // dato que el médico teclea, éste el que el sistema registra.
      expect(Date.parse(first!.at)).toBeGreaterThanOrEqual(before - 1000);
    });

    it('EN-133 firmar la 002 deja «nota firmada» con su firmante, y cerrar la cuenta «cuenta cerrada»', async () => {
      const { id } = await openEncounter();
      await signTheNote(id);
      await post(`/encounters/${id}/close`, doctorToken, {}).expect(200);

      const trail = await trailOf(id);
      expect(
        trail.map((change) => [change.from, change.to, change.fact]),
      ).toEqual([
        [null, 'OPEN', 'OPENED'],
        ['OPEN', 'DISCHARGED', 'NOTE_SIGNED'],
        ['DISCHARGED', 'COMPLETED', 'ACCOUNT_CLOSED'],
      ]);
      expect(trail.every((change) => change.byName === 'Ana Villacís')).toBe(
        true,
      );
      // En orden: cada cambio no antes que el anterior.
      const instants = trail.map((change) => Date.parse(change.at));
      expect([...instants].sort((a, b) => a - b)).toEqual(instants);
    });

    it('EN-133 interrumpir y anular dejan su hecho', async () => {
      const interrupted = await openEncounter();
      await post(`/encounters/${interrupted.id}/discontinue`, doctorToken, {
        reason: 'El paciente se retiró',
        origin: 'PATIENT',
      }).expect(200);
      expect((await trailOf(interrupted.id)).at(-1)).toMatchObject({
        from: 'OPEN',
        to: 'DISCONTINUED',
        fact: 'INTERRUPTED',
        byName: 'Ana Villacís',
      });

      const annulled = await openEncounter();
      await post(`/encounters/${annulled.id}/enter-in-error`, doctorToken, {}).expect(200); // prettier-ignore
      expect((await trailOf(annulled.id)).at(-1)).toMatchObject({
        from: 'OPEN',
        to: 'ENTERED_IN_ERROR',
        fact: 'ANNULLED',
      });
    });

    it('EN-133 EN-121 el historial de una atención de otra sede responde 404, y sin sesión 401', async () => {
      const elsewhere = await createEncounter(prisma, {
        siteId: otherSiteId,
        practitionerId: doctorPractitionerId,
        patientId,
      });
      await get(`/encounters/${elsewhere.id}/status-history`, doctorToken).expect(404); // prettier-ignore
      await request(app.getHttpServer())
        .get(`/api/v1/encounters/${elsewhere.id}/status-history`)
        .expect(401);

      // Control positivo: la de su sede sí la lee. Recepción no: el historial
      // es de la atención, y leerla pide `record:read`.
      const mine = await openEncounter();
      await get(`/encounters/${mine.id}/status-history`, doctorToken).expect(200); // prettier-ignore
      await get(`/encounters/${mine.id}/status-history`, receptionToken).expect(403); // prettier-ignore
    });
  });

  describe('EN-034 la hora real de la atención', () => {
    it('EN-034 registrar a esta hora una consulta de hace diez horas la guarda con su hora, no con la de teclearla', async () => {
      const startedAt = minutesAgo(10 * 60);
      const opened = await openEncounter(doctorToken, { startedAt });
      expect(opened.startedAt).toBe(startedAt);

      const stored = await prisma.encounter.findUniqueOrThrow({
        where: { id: opened.id },
      });
      expect(stored.startedAt.toISOString()).toBe(startedAt);
      // Y la fila se escribió ahora: son dos instantes distintos.
      expect(stored.createdAt.getTime() - stored.startedAt.getTime()).toBeGreaterThan(9 * 60 * MINUTE); // prettier-ignore
    });
  });

  describe('EN-012, EN-013 el lugar de atención y Médico del Barrio', () => {
    it('EN-012 EN-013 una atención nace en el establecimiento y fuera de la estrategia, sin preguntarlo', async () => {
      const opened = await openEncounter();
      expect(opened).toMatchObject({
        carePlace: 1,
        careSetting: 'INTRAMURAL',
        medicoDelBarrio: false,
      });
    });

    it('EN-012 EN-013 se abre con otro lugar y la estrategia, y el ámbito se deriva', async () => {
      const opened = await openEncounter(doctorToken, {
        carePlace: 4,
        medicoDelBarrio: true,
      });
      expect(opened).toMatchObject({
        carePlace: 4,
        careSetting: 'EXTRAMURAL',
        medicoDelBarrio: true,
      });
    });

    it('EN-012 un código fuera del catálogo del RDACAA se rechaza con 422 en carePlace', async () => {
      for (const carePlace of [0, 17, 97, 99]) {
        const refused = await post('/encounters', doctorToken, openBody({ carePlace })).expect(422); // prettier-ignore
        expect(
          (refused.body as { errors: { field: string }[] }).errors.map(
            (e) => e.field,
          ),
        ).toContain('carePlace');
      }
      // Control positivo: el 98 «Otros» es del catálogo.
      await post('/encounters', doctorToken, openBody({ carePlace: 98 })).expect(201); // prettier-ignore
    });

    it('EN-012 EN-013 EN-215 se corrigen en el sitio y la atención anterior queda en record_version', async () => {
      const { id } = await openEncounter();

      const corrected = await patch(`/encounters/${id}`, doctorToken, {
        carePlace: 2,
        medicoDelBarrio: true,
      }).expect(200);
      expect(corrected.body).toMatchObject({
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
        carePlace: 2,
        medicoDelBarrio: true,
      });

      const stored = await prisma.encounter.findUniqueOrThrow({
        where: { id },
      });
      expect(stored).toMatchObject({ careSetting: 'EXTRAMURAL' });
      expect(stored.correctedAt).not.toBeNull();

      const versions = await prisma.$queryRaw<{ care_place: number }[]>`
        SELECT (data->>'care_place')::int AS care_place
          FROM record_version
         WHERE resource_type = 'encounter' AND resource_id = ${id}::uuid`;
      expect(versions).toEqual([{ care_place: 1 }]);
    });

    it('EN-012 EN-215 recepción no corrige el lugar: hace falta record:write', async () => {
      const { id } = await openEncounter();
      await patch(`/encounters/${id}`, receptionToken, { carePlace: 4 }).expect(403); // prettier-ignore
      await expect(
        prisma.encounter.findUniqueOrThrow({ where: { id } }),
      ).resolves.toMatchObject({ carePlace: 1 });
    });
  });

  describe('EN-016 la cita publica si tiene atención', () => {
    it('EN-016 la agenda del día dice el estado de la atención de la cita, y no su identificador', async () => {
      const entry = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          practitionerId: doctorPractitionerId,
          patientId,
          ...hourSlot(9),
        },
      });
      const encounter = await createEncounter(prisma, {
        siteId,
        practitionerId: doctorPractitionerId,
        patientId,
        agendaEntryId: entry.id,
      });
      const date = clinicalDateOf(entry.startsAt);

      const day = await get(
        `/agenda/sites/${siteId}/entries?date=${date}`,
        receptionToken,
      ).expect(200);
      const items = (day.body as { items: { id: string; attention: string | null }[] }).items; // prettier-ignore
      expect(items.find((item) => item.id === entry.id)?.attention).toBe(
        'OPEN',
      );
      expect(JSON.stringify(day.body)).not.toContain(encounter.id);
    });
  });

  describe('EN-002 la historia se nombra por su MRN y con el documento', () => {
    it('EN-002 la ficha de la atención publica su MRN y su cédula vigente', async () => {
      await prisma.patientIdentifier.create({
        data: { patientId, type: 'CEDULA', value: '1712345675' },
      });
      const opened = await openEncounter();
      const patient = await get(`/patients/${opened.patientId as string}`, doctorToken).expect(200); // prettier-ignore
      const body = patient.body as {
        mrn: string;
        identifiers: { type: string; value: string }[];
      };
      expect(body.mrn).toMatch(/^HC/);
      expect(body.identifiers).toContainEqual(
        expect.objectContaining({ type: 'CEDULA', value: '1712345675' }),
      );
    });
  });

  describe('EN-032, EN-157, EN-158 el plazo de conservación', () => {
    it('EN-158 EN-157 se declara el mayor de las sedes, desde la última atención, sin purga', async () => {
      const declared = await get('/configuration/record-retention', adminToken).expect(200); // prettier-ignore
      expect(declared.body).toEqual({
        years: 15,
        countsFrom: 'LAST_ENCOUNTER',
        purgedOnExpiry: false,
      });

      await prisma.siteParameter.update({
        where: { siteId: otherSiteId },
        data: { recordRetentionYears: 20 },
      });
      const longest = await get('/configuration/record-retention', adminToken).expect(200); // prettier-ignore
      expect((longest.body as { years: number }).years).toBe(20);
    });

    it('EN-158 sin settings:read el plazo no se lee', async () => {
      await get('/configuration/record-retention', doctorToken).expect(403);
    });
  });
});
