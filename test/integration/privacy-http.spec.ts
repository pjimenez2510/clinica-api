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
import { legalDueDate } from '../../src/modules/privacy/domain/legal-due-date';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import {
  addDays,
  clinicalDateOf,
  isoWeekdayOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite, createUser } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

const PASSWORD = 'el caballo come alfalfa';
const DAY_MS = 24 * 60 * 60 * 1000;

// Synthetic cedulas with a computed check digit; never a real person's.
const OFFICER = { email: 'datos@clinica.ec', cedula: '1710034065' };
const DESK = { email: 'recepcion@clinica.ec', cedula: '0926687856' };

interface Problem {
  status: number;
  code: string;
  title: string;
  errors?: { field: string; code: string }[];
}

interface TextBody {
  id: string;
  version: number;
  body: string;
  publishedBy: { id: string; fullName: string };
}

interface ConsentBody {
  id: string;
  patientId: string;
  textVersion: TextBody;
  isCurrentVersion: boolean;
  medium: string;
  grantedBy: string;
  recordedAt: string;
  recordedBy: { id: string; fullName: string };
}

interface RequestBody {
  id: string;
  patientId: string;
  right: string;
  dueOn: string;
  isOverdue: boolean;
  answer: { outcome: string; response: string } | null;
}

/**
 * The privacy module over HTTP, with real sessions against a real PostgreSQL
 * (PD1 to PD4). The guarantees that are the base's alone — immutability, the
 * consecutive version — are in `privacy-immutable.spec.ts`.
 *
 * TWO ACCOUNTS. The officer holds the two privacy permissions through a role
 * created here, because NO shipped role carries them yet (D-083 §4): proving
 * the routes with ADMIN would prove a grant that does not exist. The desk holds
 * the shipped RECEPCION role, which is what proves the consent rides on
 * `patient:write` and the rest is closed to it.
 */
describe('privacy por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let officerToken: string;
  let officerId: string;
  let deskToken: string;
  let deskId: string;

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
    const officerRole = await prisma.role.create({
      data: { code: 'PROTECCION_DATOS', name: 'Protección de datos' },
    });
    await prisma.rolePermission.createMany({
      data: [
        'patient:read',
        'patient:write',
        'patient:consent-text',
        'patient:data-requests',
        // Only for PD-040's real merge: the export must follow PA-043's move
        // of the documents, which only the real merge performs.
        'patient:merge',
      ].map((permissionCode) => ({ roleId: officerRole.id, permissionCode })),
    });
    registry.invalidate();

    ({ token: officerToken, userId: officerId } = await signIn(
      OFFICER,
      'PROTECCION_DATOS',
    ));
    ({ token: deskToken, userId: deskId } = await signIn(DESK, 'RECEPCION'));
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    account: { email: string; cedula: string },
    roleCode: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email: account.email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula: account.cedula,
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
      data: { userId: user.id, roleId: role.id },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  const base = '/api/v1/privacy';
  const get = (path: string, auth = officerToken) =>
    request(app.getHttpServer())
      .get(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`);
  const post = (path: string, body: object, auth = officerToken) =>
    request(app.getHttpServer())
      .post(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  async function publish(body: string): Promise<TextBody> {
    const response = await post('/consent-texts', { body }).expect(201);
    return response.body as TextBody;
  }

  /** A merged pair: `absorbed` points at `survivor`. */
  async function mergedPair() {
    const survivor = await createPatient(prisma);
    const absorbed = await createPatient(prisma);
    return { survivor, absorbed };
  }

  async function merge(absorbedId: string, survivorId: string) {
    await prisma.patient.update({
      where: { id: absorbedId },
      data: { mergedIntoId: survivorId, mergedAt: new Date() },
    });
  }

  /**
   * Makes `access_audit` refuse one resource type and action, for the
   * fail-closed requirements. Dropped by the returned function.
   */
  async function refuseTrail(resourceType: string, action: string) {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_trail() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_type = '${resourceType}' AND NEW.action = '${action}' THEN
          RAISE EXCEPTION 'trail unavailable (test)' USING ERRCODE = 'XX000';
        END IF;
        RETURN NEW;
      END; $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER trg_test_refuse_trail BEFORE INSERT ON access_audit
      FOR EACH ROW EXECUTE FUNCTION test_refuse_trail()`);
    return async () => {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER trg_test_refuse_trail ON access_audit',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION test_refuse_trail()');
    };
  }

  /**
   * Resolves once some backend is WAITING on a lock: the request under test
   * has reached the point the race is about. A condition polled, not a sleep;
   * bounded, so a request that never blocks fails the test instead of hanging.
   */
  async function untilSomeoneWaitsOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted`;
      if (Number(row!.waiting) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('No request ever waited on a lock');
  }

  function trail(resourceType: string, resourceId: string, action: string) {
    return prisma.accessAudit.findMany({
      where: { resourceType, resourceId, action },
    });
  }

  describe('D-083 §4 qué roles de fábrica traen los permisos de privacy', () => {
    it('PD-002 PD-030 ADMIN recibe patient:consent-text y patient:data-requests al sincronizar; RECEPCION, ninguno', async () => {
      const held = async (code: string) =>
        (
          await prisma.rolePermission.findMany({
            where: { role: { code } },
            select: { permissionCode: true },
          })
        ).map((row) => row.permissionCode);

      const admin = await held('ADMIN');
      expect(admin).toEqual(
        expect.arrayContaining([
          'patient:consent-text',
          'patient:data-requests',
        ]),
      );
      const desk = await held('RECEPCION');
      expect(desk).not.toContain('patient:consent-text');
      expect(desk).not.toContain('patient:data-requests');
      // Control: RECEPCION does hold what records the consent (PD-010).
      expect(desk).toContain('patient:write');
    });
  });

  // --- PD1 -----------------------------------------------------------------------

  describe('PD1 el texto del consentimiento', () => {
    it('PD-001 PD-002 publicar crea la versión siguiente, que pasa a ser la vigente, y la anterior sigue igual', async () => {
      const first = await publish('Texto uno');
      const second = await publish('Texto dos');

      expect([first.version, second.version]).toEqual([1, 2]);
      expect(second.publishedBy).toEqual({
        id: officerId,
        fullName: 'Gabriela Mera',
      });

      const current = await get('/consent-texts/current', deskToken).expect(
        200,
      );
      expect((current.body as { current: TextBody }).current.version).toBe(2);

      const all = await get('/consent-texts').expect(200);
      const items = (all.body as { items: TextBody[] }).items;
      expect(items.map((t) => [t.version, t.body])).toEqual([
        [2, 'Texto dos'],
        [1, 'Texto uno'],
      ]);
    });

    it('PD-001 sin texto publicado, el vigente es null y no un error', async () => {
      const response = await get('/consent-texts/current', deskToken).expect(
        200,
      );
      expect(response.body).toEqual({ current: null });
    });

    it('PD-012 consentir una versión que no existe es CONSENT_TEXT_NOT_PUBLISHED', async () => {
      await publish('Texto uno');
      const patient = await createPatient(prisma);
      const response = await post(
        `/patients/${patient.id}/consents`,
        {
          textVersionId: crypto.randomUUID(),
          medium: 'ON_SCREEN',
          grantedBy: 'HOLDER',
        },
        deskToken,
      ).expect(404);
      expect((response.body as Problem).code).toBe(
        'CONSENT_TEXT_NOT_PUBLISHED',
      );
    });

    it('PD-004 un texto en blanco o demasiado largo se rechaza sin publicar nada', async () => {
      for (const body of ['   ', 'x'.repeat(20_001)]) {
        const response = await post('/consent-texts', { body }).expect(422);
        expect((response.body as Problem).code).toBe('CONSENT_TEXT_INVALID');
      }
      expect(await prisma.consentTextVersion.count()).toBe(0);
      // Positive control: the limit itself is accepted.
      await post('/consent-texts', { body: 'x'.repeat(20_000) }).expect(201);
    });

    it('PD-005 si otra escritura gana el número mientras se publica, la publicación recibe CONSENT_TEXT_VERSION_CONFLICT y no escribe nada', async () => {
      await publish('Texto uno');
      const author = await createUser(prisma);

      // Another writer holds version 2, uncommitted, while the request runs.
      let response: request.Response | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.consentTextVersion.create({
            data: { version: 2, body: 'El otro', publishedBy: author.id },
          });
          const inFlight = post('/consent-texts', { body: 'Este' }).then(
            (r) => (response = r),
          );
          await untilSomeoneWaitsOnALock();
          void inFlight;
        },
        { timeout: 20_000 },
      );
      await new Promise<void>((resolve) => {
        const check = () => (response ? resolve() : setImmediate(check));
        check();
      });

      expect(response!.status).toBe(409);
      expect((response!.body as Problem).code).toBe(
        'CONSENT_TEXT_VERSION_CONFLICT',
      );
      const versions = await prisma.consentTextVersion.findMany({
        orderBy: { version: 'asc' },
        select: { version: true, body: true },
      });
      expect(versions).toEqual([
        { version: 1, body: 'Texto uno' },
        { version: 2, body: 'El otro' },
      ]);
      // Control: once nobody holds the number, the same publication goes in.
      await post('/consent-texts', { body: 'Este' }).expect(201);
    });

    it('PD-005 dos publicaciones desde la aplicación a la vez se ordenan: las dos salen, con números seguidos', async () => {
      const [a, b] = await Promise.all([
        post('/consent-texts', { body: 'A' }),
        post('/consent-texts', { body: 'B' }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(
        [(a.body as TextBody).version, (b.body as TextBody).version].sort(),
      ).toEqual([1, 2]);
    });

    it('PD-012 un consentimiento que llega mientras se publica una versión nueva espera y se rechaza: no queda ligado a la superada', async () => {
      const first = await publish('Texto uno');
      const patient = await createPatient(prisma);
      const author = await createUser(prisma);

      let response: request.Response | undefined;
      await prisma.$transaction(
        async (tx) => {
          // What `publish` does: the exclusive lock, then the next version.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x70726976}::bigint)`;
          await tx.consentTextVersion.create({
            data: { version: 2, body: 'Texto dos', publishedBy: author.id },
          });
          const inFlight = post(
            `/patients/${patient.id}/consents`,
            {
              textVersionId: first.id,
              medium: 'ON_SCREEN',
              grantedBy: 'HOLDER',
            },
            deskToken,
          ).then((r) => (response = r));
          await untilSomeoneWaitsOnALock();
          void inFlight;
        },
        { timeout: 20_000 },
      );
      await new Promise<void>((resolve) => {
        const check = () => (response ? resolve() : setImmediate(check));
        check();
      });

      expect(response!.status).toBe(409);
      expect((response!.body as Problem).code).toBe('CONSENT_TEXT_OUTDATED');
      expect(await prisma.patientConsent.count()).toBe(0);
    });

    it('PD-006 la publicación deja su fila en la bitácora, y sin bitácora no se publica', async () => {
      const text = await publish('Texto con rastro');
      const rows = await trail('consent_text_version', text.id, 'CREATE');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(officerId);
      expect(rows[0]!.before).toBeNull();

      const restore = await refuseTrail('consent_text_version', 'CREATE');
      try {
        await post('/consent-texts', { body: 'Sin rastro' }).expect(500);
      } finally {
        await restore();
      }
      expect(await prisma.consentTextVersion.count()).toBe(1);
    });

    it('PD-002 recepción no administra el texto: cerrado por defecto', async () => {
      await get('/consent-texts', deskToken).expect(403);
      await post('/consent-texts', { body: 'Intento' }, deskToken).expect(403);
    });
  });

  // --- PD2 -----------------------------------------------------------------------

  describe('PD2 el consentimiento del paciente', () => {
    it('PD-010 PD-011 recepción registra el consentimiento; el instante y el autor son del servidor', async () => {
      const text = await publish('Texto uno');
      const patient = await createPatient(prisma);
      const before = Date.now();

      const response = await post(
        `/patients/${patient.id}/consents`,
        { textVersionId: text.id, medium: 'ON_SCREEN', grantedBy: 'HOLDER' },
        deskToken,
      ).expect(201);
      const consent = response.body as ConsentBody;

      expect(consent).toMatchObject({
        patientId: patient.id,
        medium: 'ON_SCREEN',
        grantedBy: 'HOLDER',
        isCurrentVersion: true,
        recordedBy: { id: deskId },
        textVersion: { version: 1, body: 'Texto uno' },
      });
      expect(Date.parse(consent.recordedAt)).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it('PD-011 el cliente no puede mandar el instante ni el autor', async () => {
      const text = await publish('Texto uno');
      const patient = await createPatient(prisma);

      await post(
        `/patients/${patient.id}/consents`,
        {
          textVersionId: text.id,
          medium: 'SIGNED_PAPER',
          grantedBy: 'HOLDER',
          recordedAt: new Date(Date.now() - DAY_MS).toISOString(),
          recordedBy: officerId,
        },
        deskToken,
      ).expect(422);
      expect(await prisma.patientConsent.count()).toBe(0);
    });

    it('PD-012 consentir una versión que ya no es la vigente se rechaza sin escribir nada', async () => {
      const first = await publish('Texto uno');
      await publish('Texto dos');
      const patient = await createPatient(prisma);

      const response = await post(
        `/patients/${patient.id}/consents`,
        { textVersionId: first.id, medium: 'ON_SCREEN', grantedBy: 'HOLDER' },
        deskToken,
      ).expect(409);
      expect((response.body as Problem).code).toBe('CONSENT_TEXT_OUTDATED');
      expect(await prisma.patientConsent.count()).toBe(0);
    });

    it('PD-013 PD-016 una versión nueva no cambia lo ya consentido, y la lista lo dice', async () => {
      const first = await publish('Texto uno');
      const patient = await createPatient(prisma);
      await post(
        `/patients/${patient.id}/consents`,
        {
          textVersionId: first.id,
          medium: 'SIGNED_PAPER',
          grantedBy: 'REPRESENTATIVE',
        },
        deskToken,
      ).expect(201);

      await publish('Texto dos');

      const list = await get(
        `/patients/${patient.id}/consents`,
        deskToken,
      ).expect(200);
      const [only] = (list.body as { items: ConsentBody[] }).items;
      expect(only).toMatchObject({
        medium: 'SIGNED_PAPER',
        grantedBy: 'REPRESENTATIVE',
        isCurrentVersion: false,
        textVersion: { version: 1, body: 'Texto uno' },
      });
    });

    it('PD-015 ficha inexistente o absorbida: no se registra nada', async () => {
      const text = await publish('Texto uno');
      const { survivor, absorbed } = await mergedPair();
      await merge(absorbed.id, survivor.id);
      const body = {
        textVersionId: text.id,
        medium: 'ON_SCREEN',
        grantedBy: 'HOLDER',
      };

      const missing = await post(
        `/patients/${crypto.randomUUID()}/consents`,
        body,
        deskToken,
      ).expect(404);
      expect((missing.body as Problem).code).toBe('DATA_SUBJECT_NOT_FOUND');

      const merged = await post(
        `/patients/${absorbed.id}/consents`,
        body,
        deskToken,
      ).expect(409);
      expect((merged.body as Problem).code).toBe('PATIENT_MERGED');
      expect(await prisma.patientConsent.count()).toBe(0);
    });

    it('PD-016 la ficha superviviente muestra el consentimiento firmado en la absorbida', async () => {
      const text = await publish('Texto uno');
      const { survivor, absorbed } = await mergedPair();
      await post(
        `/patients/${absorbed.id}/consents`,
        { textVersionId: text.id, medium: 'ON_SCREEN', grantedBy: 'HOLDER' },
        deskToken,
      ).expect(201);
      await merge(absorbed.id, survivor.id);

      const list = await get(
        `/patients/${survivor.id}/consents`,
        deskToken,
      ).expect(200);
      const items = (list.body as { items: ConsentBody[] }).items;
      expect(items.map((c) => c.patientId)).toEqual([absorbed.id]);
    });

    it('PD-017 el consentimiento deja su fila en la bitácora, y sin bitácora no se registra', async () => {
      const text = await publish('Texto uno');
      const patient = await createPatient(prisma);
      const body = {
        textVersionId: text.id,
        medium: 'ON_SCREEN',
        grantedBy: 'HOLDER',
      };

      const created = await post(
        `/patients/${patient.id}/consents`,
        body,
        deskToken,
      ).expect(201);
      const rows = await trail(
        'patient_consent',
        (created.body as ConsentBody).id,
        'CREATE',
      );
      expect(rows.map((r) => r.userId)).toEqual([deskId]);

      const restore = await refuseTrail('patient_consent', 'CREATE');
      try {
        await post(`/patients/${patient.id}/consents`, body, deskToken).expect(
          500,
        );
      } finally {
        await restore();
      }
      expect(await prisma.patientConsent.count()).toBe(1);
    });
  });

  // --- PD3 -----------------------------------------------------------------------

  describe('PD3 las solicitudes del titular', () => {
    const register = (
      patientId: string,
      body: Record<string, unknown>,
      auth = officerToken,
    ) =>
      post(
        `/patients/${patientId}/requests`,
        { requestedBy: 'HOLDER', description: 'Copia de mis datos', ...body },
        auth,
      );

    /** The next weekday from today, in the clinic's calendar. */
    function nextWeekday(): ClinicalDate {
      let day = addDays(clinicalDateOf(new Date()), 1);
      while (isoWeekdayOf(day) > 5) day = addDays(day, 1);
      return day;
    }

    it('PD-030 PD-032 registra la solicitud con su vencimiento, contando los feriados de toda la clínica', async () => {
      const patient = await createPatient(prisma);
      const receivedOn = clinicalDateOf(new Date());
      const holiday = nextWeekday();
      await prisma.holiday.create({
        data: { date: new Date(`${holiday}T00:00:00Z`), name: 'Feriado' },
      });

      const response = await register(patient.id, {
        right: 'PORTABILITY',
      }).expect(201);
      const created = response.body as RequestBody;

      const expected = legalDueDate(
        'PORTABILITY',
        receivedOn,
        new Set([holiday]),
      );
      expect(created.dueOn).toBe(expected);
      // Control: the holiday is what moved it.
      expect(expected).not.toBe(
        legalDueDate('PORTABILITY', receivedOn, new Set()),
      );
      expect(created).toMatchObject({
        patientId: patient.id,
        right: 'PORTABILITY',
        isOverdue: false,
        answer: null,
      });
    });

    it('PD-032 un feriado de UNA sede no cuenta, y uno añadido después no mueve el vencimiento ya fijado', async () => {
      const patient = await createPatient(prisma);
      const site = await createSite(prisma);
      const receivedOn = clinicalDateOf(new Date());
      const holiday = nextWeekday();
      await prisma.holiday.create({
        data: {
          date: new Date(`${holiday}T00:00:00Z`),
          name: 'Feriado local',
          siteId: site.id,
        },
      });

      const created = (
        await register(patient.id, { right: 'PORTABILITY' }).expect(201)
      ).body as RequestBody;
      const noHolidays = legalDueDate('PORTABILITY', receivedOn, new Set());
      expect(created.dueOn).toBe(noHolidays);

      await prisma.holiday.create({
        data: { date: new Date(`${holiday}T00:00:00Z`), name: 'Nacional' },
      });
      const list = await get(`/patients/${patient.id}/requests`).expect(200);
      expect((list.body as { items: RequestBody[] }).items[0]!.dueOn).toBe(
        noHolidays,
      );
    });

    it('PD-031 una recepción futura se rechaza; una pasada cuenta desde su fecha', async () => {
      const patient = await createPatient(prisma);
      const future = new Date(Date.now() + DAY_MS).toISOString();
      const response = await register(patient.id, {
        right: 'ACCESS',
        receivedAt: future,
      }).expect(422);
      expect((response.body as Problem).code).toBe(
        'DATA_REQUEST_RECEIVED_IN_FUTURE',
      );

      const past = new Date(Date.now() - 3 * DAY_MS);
      const created = (
        await register(patient.id, {
          right: 'SUSPENSION',
          receivedAt: past.toISOString(),
        }).expect(201)
      ).body as RequestBody;
      expect(created.dueOn).toBe(
        legalDueDate('SUSPENSION', clinicalDateOf(past), new Set()),
      );
    });

    it('PD-030 ficha inexistente o absorbida: no se registra nada', async () => {
      const { survivor, absorbed } = await mergedPair();
      await merge(absorbed.id, survivor.id);

      const missing = await register(crypto.randomUUID(), {
        right: 'ACCESS',
      }).expect(404);
      expect((missing.body as Problem).code).toBe('DATA_SUBJECT_NOT_FOUND');
      const merged = await register(absorbed.id, { right: 'ACCESS' }).expect(
        409,
      );
      expect((merged.body as Problem).code).toBe('PATIENT_MERGED');
      expect(await prisma.dataSubjectRequest.count()).toBe(0);
    });

    it('PD-033 PD-037 se responde una vez, con rastro de las dos acciones; la segunda respuesta se rechaza', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;

      const answered = await post(`/requests/${created.id}/response`, {
        outcome: 'GRANTED',
        response: 'Se entregó la exportación en JSON',
      }).expect(200);
      expect((answered.body as RequestBody).answer).toMatchObject({
        outcome: 'GRANTED',
        response: 'Se entregó la exportación en JSON',
      });

      const again = await post(`/requests/${created.id}/response`, {
        outcome: 'DENIED',
        response: 'Otra',
      }).expect(409);
      expect((again.body as Problem).code).toBe(
        'DATA_REQUEST_ALREADY_ANSWERED',
      );

      expect(
        await trail('data_subject_request', created.id, 'CREATE'),
      ).toHaveLength(1);
      expect(
        await trail('data_subject_request', created.id, 'UPDATE'),
      ).toHaveLength(1);

      const missing = await post(`/requests/${crypto.randomUUID()}/response`, {
        outcome: 'GRANTED',
        response: 'x',
      }).expect(404);
      expect((missing.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
    });

    it('PD-033 dos respuestas a la vez: exactamente una gana, y queda una sola fila de respuesta en la bitácora', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;

      const responses = await Promise.all(
        ['GRANTED', 'DENIED'].map((outcome) =>
          post(`/requests/${created.id}/response`, {
            outcome,
            response: `Respuesta ${outcome}`,
          }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = responses.find((r) => r.status === 409)!;
      expect((loser.body as Problem).code).toBe(
        'DATA_REQUEST_ALREADY_ANSWERED',
      );
      const winner = responses.find((r) => r.status === 200)!;
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.outcome).toBe((winner.body as RequestBody).answer!.outcome);
      expect(
        await trail('data_subject_request', created.id, 'UPDATE'),
      ).toHaveLength(1);
    });

    it('PD-037 sin bitácora no se registra ni se responde', async () => {
      const patient = await createPatient(prisma);
      const restore = await refuseTrail('data_subject_request', 'CREATE');
      try {
        await register(patient.id, { right: 'ACCESS' }).expect(500);
      } finally {
        await restore();
      }
      expect(await prisma.dataSubjectRequest.count()).toBe(0);

      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;
      const restoreAnswer = await refuseTrail('data_subject_request', 'UPDATE');
      try {
        await post(`/requests/${created.id}/response`, {
          outcome: 'GRANTED',
          response: 'x',
        }).expect(500);
      } finally {
        await restoreAnswer();
      }
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.outcome).toBeNull();
    });

    it('PD-034 responder una eliminación, aun «atendida», no borra ni cambia la ficha', async () => {
      const patient = await createPatient(prisma);
      const before = await prisma.patient.findUniqueOrThrow({
        where: { id: patient.id },
      });
      const created = (
        await register(patient.id, {
          right: 'ERASURE',
          description: 'Que borren todos mis datos',
        }).expect(201)
      ).body as RequestBody;

      await post(`/requests/${created.id}/response`, {
        outcome: 'GRANTED',
        response: 'Atendida',
      }).expect(200);

      const after = await prisma.patient.findUniqueOrThrow({
        where: { id: patient.id },
      });
      expect(after).toEqual(before);
    });

    it('PD-035 las abiertas de toda la clínica, por vencimiento, con las vencidas marcadas y sin las respondidas', async () => {
      const [a, b, c] = await Promise.all([
        createPatient(prisma),
        createPatient(prisma),
        createPatient(prisma),
      ]);
      const recent = (await register(a.id, { right: 'ACCESS' }).expect(201))
        .body as RequestBody;
      const old = (
        await register(b.id, {
          right: 'SUSPENSION',
          receivedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
        }).expect(201)
      ).body as RequestBody;
      const answered = (await register(c.id, { right: 'ACCESS' }).expect(201))
        .body as RequestBody;
      await post(`/requests/${answered.id}/response`, {
        outcome: 'DENIED',
        response: 'No acreditó identidad',
      }).expect(200);

      const list = await get('/requests').expect(200);
      const items = (list.body as { items: RequestBody[] }).items;
      expect(items.map((r) => [r.id, r.isOverdue])).toEqual([
        [old.id, true],
        [recent.id, false],
      ]);
    });

    it('PD-036 la ficha superviviente muestra las solicitudes de la absorbida', async () => {
      const { survivor, absorbed } = await mergedPair();
      const created = (
        await register(absorbed.id, { right: 'RECTIFICATION' }).expect(201)
      ).body as RequestBody;
      await merge(absorbed.id, survivor.id);

      const list = await get(`/patients/${survivor.id}/requests`).expect(200);
      expect(
        (list.body as { items: RequestBody[] }).items.map((r) => r.id),
      ).toEqual([created.id]);
    });

    it('PD-030 recepción no ve ni registra solicitudes: cerrado por defecto', async () => {
      const patient = await createPatient(prisma);
      await register(patient.id, { right: 'ACCESS' }, deskToken).expect(403);
      await get('/requests', deskToken).expect(403);
      await get(`/patients/${patient.id}/requests`, deskToken).expect(403);
    });
  });

  // --- PD4 -----------------------------------------------------------------------

  describe('PD4 la exportación', () => {
    async function requestFor(patientId: string, right: string) {
      const response = await post(`/patients/${patientId}/requests`, {
        right,
        requestedBy: 'HOLDER',
        description: 'Mis datos',
      }).expect(201);
      return response.body as RequestBody;
    }

    it('PD-040 PD-041 exporta en JSON la ficha y su absorbida, con lo que no incluye declarado', async () => {
      const text = await publish('Texto consentido');
      const { survivor, absorbed } = await mergedPair();
      await prisma.patientIdentifier.create({
        data: { patientId: absorbed.id, type: 'PASSPORT', value: 'AB12345' },
      });
      await post(
        `/patients/${absorbed.id}/consents`,
        { textVersionId: text.id, medium: 'SIGNED_PAPER', grantedBy: 'HOLDER' },
        deskToken,
      ).expect(201);
      await merge(absorbed.id, survivor.id);
      const access = await requestFor(survivor.id, 'ACCESS');

      const response = await get(`/requests/${access.id}/export`).expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['content-disposition']).toMatch(/attachment/);
      const document = response.body as Record<string, unknown> & {
        patient: Record<string, unknown> & { mergedCharts: { mrn: string }[] };
        identifiers: { chart: string; value: string }[];
        consents: { text: string; textVersion: number }[];
        requests: { right: string }[];
        omitted: { section: string }[];
      };
      expect(document).toMatchObject({
        format: 'clinica.privacy.export',
        formatVersion: 1,
      });
      expect(document.patient.mrn).toBe(survivor.mrn);
      expect(document.patient.mergedCharts.map((c) => c.mrn)).toEqual([
        absorbed.mrn,
      ]);
      expect(document.identifiers).toEqual([
        expect.objectContaining({ chart: absorbed.mrn, value: 'AB12345' }),
      ]);
      expect(document.consents).toEqual([
        expect.objectContaining({ textVersion: 1, text: 'Texto consentido' }),
      ]);
      expect(document.requests.map((r) => r.right)).toEqual(['ACCESS']);
      expect(document.omitted.map((o) => o.section)).toEqual([
        'clinical_record',
        'sexual_orientation',
        'priority_groups',
        'contacts',
        'appointments',
        'billing',
        'record_corrections',
        'access_log',
      ]);
      expect(JSON.stringify(document)).not.toMatch(/sexualOrientation/);
    });

    it('PD-040 PD-043 una solicitud registrada en una ficha que luego se fusiona exporta la superviviente, con los documentos que la fusión le pasó', async () => {
      const { survivor, absorbed } = await mergedPair();
      await prisma.patientIdentifier.create({
        data: { patientId: absorbed.id, type: 'PASSPORT', value: 'ZX98765' },
      });
      const access = await requestFor(absorbed.id, 'ACCESS');

      // The REAL merge: it moves the official documents (PA-043).
      await request(app.getHttpServer())
        .post(`/api/v1/patients/${absorbed.id}/merge`)
        .set('Authorization', `Bearer ${officerToken}`)
        .send({ targetPatientId: survivor.id, reason: 'La misma persona' })
        .expect(200);

      const response = await get(`/requests/${access.id}/export`).expect(200);
      const document = response.body as {
        patient: { mrn: string; mergedCharts: { mrn: string }[] };
        identifiers: { value: string }[];
        requests: { right: string }[];
      };
      expect(document.patient.mrn).toBe(survivor.mrn);
      expect(document.patient.mergedCharts.map((c) => c.mrn)).toEqual([
        absorbed.mrn,
      ]);
      expect(document.identifiers.map((i) => i.value)).toContain('ZX98765');
      expect(document.requests.map((r) => r.right)).toEqual(['ACCESS']);

      // One EXPORT row per chart whose data left, and one naming the request.
      expect(await trail('patient', survivor.id, 'EXPORT')).toHaveLength(1);
      expect(await trail('patient', absorbed.id, 'EXPORT')).toHaveLength(1);
      expect(
        await trail('data_subject_request', access.id, 'EXPORT'),
      ).toHaveLength(1);
    });

    it('PD-042 una solicitud que no es de acceso ni portabilidad no se exporta, ni deja rastro', async () => {
      const patient = await createPatient(prisma);
      const erasure = await requestFor(patient.id, 'ERASURE');

      const response = await get(`/requests/${erasure.id}/export`).expect(422);
      expect((response.body as Problem).code).toBe(
        'DATA_EXPORT_NOT_APPLICABLE',
      );
      expect(await trail('patient', patient.id, 'EXPORT')).toHaveLength(0);
    });

    it('PD-043 toda exportación deja una fila EXPORT, y sin ella no sale nada', async () => {
      const patient = await createPatient(prisma);
      const portability = await requestFor(patient.id, 'PORTABILITY');

      await get(`/requests/${portability.id}/export`).expect(200);
      const rows = await trail('patient', patient.id, 'EXPORT');
      expect(rows.map((r) => r.userId)).toEqual([officerId]);

      const restore = await refuseTrail('patient', 'EXPORT');
      try {
        const refused = await get(`/requests/${portability.id}/export`).expect(
          500,
        );
        expect(JSON.stringify(refused.body)).not.toContain(patient.mrn);
      } finally {
        await restore();
      }
      expect(await trail('patient', patient.id, 'EXPORT')).toHaveLength(1);
    });

    it('PD-040 recepción no exporta: cerrado por defecto', async () => {
      const patient = await createPatient(prisma);
      const access = await requestFor(patient.id, 'ACCESS');
      await get(`/requests/${access.id}/export`, deskToken).expect(403);
    });
  });
});
