import { randomUUID } from 'node:crypto';

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
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

const PASSWORD = 'el caballo come alfalfa';
const DAY_MS = 24 * 60 * 60 * 1000;

// Synthetic cedulas with a computed check digit; never a real person's.
const OFFICER = { email: 'datos@clinica.ec', cedula: '1710034065' };
const DESK = { email: 'recepcion@clinica.ec', cedula: '0926687856' };
const SHIPPED_ADMIN = { email: 'gerencia@clinica.ec', cedula: '1712345675' };

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

interface AuthorizationBody {
  id: string;
  patientId: string;
  purpose: string;
  channel: string | null;
  recordedAt: string;
  recordedBy: { id: string; fullName: string };
  revokedAt: string | null;
  revokedBy: { id: string; fullName: string } | null;
}

interface AnswerBody {
  outcome: string;
  response: string;
  answeredAt: string;
  answeredBy: { id: string; fullName: string };
  /** PD-047. Whether this answer rectifies an earlier one. */
  isCorrection: boolean;
}

interface RequestBody {
  id: string;
  patientId: string;
  right: string;
  description: string | null;
  receivedAt: string;
  dueOn: string;
  isOverdue: boolean;
  answer: AnswerBody | null;
  /** PD-047. The answers a rectification replaced, newest first. */
  previousAnswers: AnswerBody[];
  /** PD-046. Who last edited the request and when. */
  changedBy: { id: string; fullName: string } | null;
  changedAt: string | null;
}

/**
 * The privacy module over HTTP, with real sessions against a real PostgreSQL
 * (D1, D3, D4, D8). The guarantees that are the base's alone — immutability,
 * the consecutive version, one standing authorization — are in
 * `privacy-immutable.spec.ts`.
 *
 * TWO ACCOUNTS. The officer holds the two privacy permissions through a role
 * created here, with exactly the two plus `patient:read`/`patient:write` —
 * the shipped ADMIN carries the two but not `patient:read` (D-083 §4, D-098
 * §6), and its own describe pins what that lets it do. The desk holds
 * the shipped RECEPCION role, which is what proves the authorizations ride on
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
        'privacy:notice',
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

  const patch = (path: string, body: object, auth = officerToken) =>
    request(app.getHttpServer())
      .patch(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  /** Waits until `count` sessions are blocked on a row lock. */
  async function waitForLockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (Number(row?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the edits never reached the lock');
  }

  async function publish(body: string): Promise<TextBody> {
    const response = await post('/notices', { body }).expect(201);
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
      // In THIS database only, and on the lock the race is about: the server
      // is shared with other sessions' databases, whose waits would otherwise
      // count as ours.
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE NOT l.granted
           AND a.datname = current_database()
           AND l.locktype = 'transactionid'`;
      if (Number(row!.waiting) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('No request ever waited on the lock under test');
  }

  /** Adds a permission to the officer's role; the registry reads it live. */
  async function grantToOfficer(permissionCode: string): Promise<void> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'PROTECCION_DATOS' },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionCode },
    });
    registry.invalidate();
  }

  function trail(resourceType: string, resourceId: string, action: string) {
    return prisma.accessAudit.findMany({
      where: { resourceType, resourceId, action },
    });
  }

  describe('D-083 §4 qué roles de fábrica traen los permisos de privacy', () => {
    it('PD-002 PD-030 ADMIN recibe privacy:notice y patient:data-requests al sincronizar; RECEPCION, ninguno', async () => {
      const held = async (code: string) =>
        (
          await prisma.rolePermission.findMany({
            where: { role: { code } },
            select: { permissionCode: true },
          })
        ).map((row) => row.permissionCode);

      const admin = await held('ADMIN');
      expect(admin).toEqual(
        expect.arrayContaining(['privacy:notice', 'patient:data-requests']),
      );
      const desk = await held('RECEPCION');
      expect(desk).not.toContain('privacy:notice');
      expect(desk).not.toContain('patient:data-requests');
      // Control: RECEPCION does hold what records an authorization (PD-068).
      expect(desk).toContain('patient:write');
    });

    it('PD-030 PD-040 D-083 §4 el ADMIN de fábrica registra, exporta y responde por la API sin abrir la ficha (D-098 §6), y la lista global no le da el texto libre', async () => {
      const { token: adminToken } = await signIn(SHIPPED_ADMIN, 'ADMIN');
      const patient = await createPatient(prisma);

      // What D-083 §4 grants, pinned: the whole cycle, no chart needed.
      const created = (
        await post(
          `/patients/${patient.id}/requests`,
          { right: 'ACCESS', requestedBy: 'HOLDER', description: 'Copia' },
          adminToken,
        ).expect(201)
      ).body as RequestBody;
      await get(`/requests/${created.id}/export`, adminToken).expect(200);

      const open = await get('/requests', adminToken).expect(200);
      const [row] = (
        open.body as {
          items: (RequestBody & {
            description: string | null;
          })[];
        }
      ).items;
      expect(row!.id).toBe(created.id);
      expect(row!.description).toBeNull();

      await post(
        `/requests/${created.id}/response`,
        { outcome: 'GRANTED', response: 'Entregada' },
        adminToken,
      ).expect(200);

      // And what it still lacks: the chart itself (`patient:read`).
      await request(app.getHttpServer())
        .get(`/api/v1/patients/${patient.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });
  });

  // --- D1 ------------------------------------------------------------------------

  describe('D1 el aviso de privacidad', () => {
    it('PD-001 PD-002 publicar crea la versión siguiente, que encabeza la lista, y la anterior sigue igual', async () => {
      await get('/notices').expect(200, { items: [] });
      const first = await publish('Aviso uno');
      const second = await publish('Aviso dos');

      expect([first.version, second.version]).toEqual([1, 2]);
      expect(second.publishedBy).toEqual({
        id: officerId,
        fullName: 'Gabriela Mera',
      });

      const all = await get('/notices').expect(200);
      const items = (all.body as { items: TextBody[] }).items;
      expect(items.map((t) => [t.version, t.body])).toEqual([
        [2, 'Aviso dos'],
        [1, 'Aviso uno'],
      ]);
    });

    it('PD-004 un aviso en blanco o demasiado largo se rechaza sin publicar nada', async () => {
      for (const body of ['   ', 'x'.repeat(20_001)]) {
        const response = await post('/notices', { body }).expect(422);
        expect((response.body as Problem).code).toBe('PRIVACY_NOTICE_INVALID');
      }
      expect(await prisma.privacyNoticeVersion.count()).toBe(0);
      // Positive control: the limit itself is accepted.
      await post('/notices', { body: 'x'.repeat(20_000) }).expect(201);
    });

    it('PD-005 si otra escritura gana el número mientras se publica, la publicación recibe PRIVACY_NOTICE_VERSION_CONFLICT y no escribe nada', async () => {
      await publish('Aviso uno');
      const author = await createUser(prisma);

      // Another writer holds version 2, uncommitted, while the request runs.
      let response: request.Response | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.privacyNoticeVersion.create({
            data: { version: 2, body: 'El otro', publishedBy: author.id },
          });
          const inFlight = post('/notices', { body: 'Este' }).then(
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
        'PRIVACY_NOTICE_VERSION_CONFLICT',
      );
      const versions = await prisma.privacyNoticeVersion.findMany({
        orderBy: { version: 'asc' },
        select: { version: true, body: true },
      });
      expect(versions).toEqual([
        { version: 1, body: 'Aviso uno' },
        { version: 2, body: 'El otro' },
      ]);
      // Control: once nobody holds the number, the same publication goes in.
      await post('/notices', { body: 'Este' }).expect(201);
    });

    it('PD-005 dos publicaciones desde la aplicación a la vez se ordenan: las dos salen, con números seguidos', async () => {
      const [a, b] = await Promise.all([
        post('/notices', { body: 'A' }),
        post('/notices', { body: 'B' }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(
        [(a.body as TextBody).version, (b.body as TextBody).version].sort(),
      ).toEqual([1, 2]);
    });

    it('PD-006 la publicación deja su fila en la bitácora, y sin bitácora no se publica', async () => {
      const text = await publish('Aviso con rastro');
      const rows = await trail('privacy_notice_version', text.id, 'CREATE');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(officerId);
      expect(rows[0]!.before).toBeNull();

      const restore = await refuseTrail('privacy_notice_version', 'CREATE');
      try {
        await post('/notices', { body: 'Sin rastro' }).expect(500);
      } finally {
        await restore();
      }
      expect(await prisma.privacyNoticeVersion.count()).toBe(1);
    });

    it('PD-002 recepción no administra el aviso: cerrado por defecto', async () => {
      await get('/notices', deskToken).expect(403);
      await post('/notices', { body: 'Intento' }, deskToken).expect(403);
    });
  });

  // --- D8 ------------------------------------------------------------------------

  describe('D8 las autorizaciones opcionales', () => {
    async function chartWithContact() {
      const patient = await createPatient(prisma);
      return prisma.patient.update({
        where: { id: patient.id },
        data: { phone: '0991234567', email: 'paciente@example.com' },
      });
    }

    const grant = (patientId: string, body: object, auth = deskToken) =>
      post(`/patients/${patientId}/authorizations`, body, auth);

    it('PD-068 PD-069 PD-073 recepción autoriza recordatorios por WhatsApp; el instante y el autor son del servidor', async () => {
      const patient = await chartWithContact();
      const before = Date.now();

      const response = await grant(patient.id, {
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
      }).expect(201);
      const granted = response.body as AuthorizationBody;
      expect(granted).toMatchObject({
        patientId: patient.id,
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
        recordedBy: { id: deskId, fullName: 'Gabriela Mera' },
        revokedAt: null,
        revokedBy: null,
      });
      expect(Date.parse(granted.recordedAt)).toBeGreaterThanOrEqual(before);

      const list = await get(
        `/patients/${patient.id}/authorizations`,
        deskToken,
      ).expect(200);
      expect((list.body as { items: AuthorizationBody[] }).items).toEqual([
        granted,
      ]);
    });

    it('PD-069 el cliente no puede mandar el instante ni el autor', async () => {
      const patient = await chartWithContact();
      await grant(patient.id, {
        purpose: 'PHOTOS',
        recordedAt: new Date(0).toISOString(),
        recordedBy: officerId,
      }).expect(422);
      expect(await prisma.patientAuthorization.count()).toBe(0);
      // Positive control: without them, it goes in.
      await grant(patient.id, { purpose: 'PHOTOS' }).expect(201);
    });

    it('PD-070 sin teléfono no se autoriza por WhatsApp, y el canal tiene que casar con la finalidad', async () => {
      const bare = await createPatient(prisma);
      for (const body of [
        { purpose: 'REMINDERS', channel: 'WHATSAPP' },
        { purpose: 'MARKETING', channel: 'EMAIL' },
        { purpose: 'REMINDERS' },
        { purpose: 'RESEARCH', channel: 'EMAIL' },
      ]) {
        const response = await grant(bare.id, body).expect(422);
        expect((response.body as Problem).code).toBe(
          'PRIVACY_AUTHORIZATION_INVALID',
        );
      }
      expect(await prisma.patientAuthorization.count()).toBe(0);
      // Positive control: with the phone, the same one goes in.
      const patient = await chartWithContact();
      await grant(patient.id, {
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
      }).expect(201);
    });

    it('PD-071 PD-072 la segunda vigente se rechaza; revocada, sigue en la lista con quién y cuándo, y se vuelve a autorizar', async () => {
      const patient = await chartWithContact();
      const first = (
        await grant(patient.id, {
          purpose: 'MARKETING',
          channel: 'EMAIL',
        }).expect(201)
      ).body as AuthorizationBody;

      const again = await grant(patient.id, {
        purpose: 'MARKETING',
        channel: 'EMAIL',
      }).expect(409);
      expect((again.body as Problem).code).toBe(
        'PRIVACY_AUTHORIZATION_ALREADY_GRANTED',
      );

      const revoked = (
        await post(
          `/patients/${patient.id}/authorizations/${first.id}/revocation`,
          {},
          deskToken,
        ).expect(201)
      ).body as AuthorizationBody;
      expect(revoked.revokedBy).toEqual({
        id: deskId,
        fullName: 'Gabriela Mera',
      });
      expect(revoked.revokedAt).not.toBeNull();

      const twice = await post(
        `/patients/${patient.id}/authorizations/${first.id}/revocation`,
        {},
        deskToken,
      ).expect(409);
      expect((twice.body as Problem).code).toBe(
        'PRIVACY_AUTHORIZATION_ALREADY_REVOKED',
      );

      await grant(patient.id, {
        purpose: 'MARKETING',
        channel: 'EMAIL',
      }).expect(201);
      const list = (
        await get(`/patients/${patient.id}/authorizations`, deskToken).expect(
          200,
        )
      ).body as { items: AuthorizationBody[] };
      expect(list.items.map((a) => a.revokedAt === null)).toEqual([
        true,
        false,
      ]);
    });

    it('PD-072 una autorización de otra ficha no existe para esta', async () => {
      const [a, b] = [await chartWithContact(), await chartWithContact()];
      const ofA = (await grant(a.id, { purpose: 'PHOTOS' }).expect(201))
        .body as AuthorizationBody;
      const response = await post(
        `/patients/${b.id}/authorizations/${ofA.id}/revocation`,
        {},
        deskToken,
      ).expect(404);
      expect((response.body as Problem).code).toBe(
        'PRIVACY_AUTHORIZATION_NOT_FOUND',
      );
      // Positive control: through its own chart, it is revoked.
      await post(
        `/patients/${a.id}/authorizations/${ofA.id}/revocation`,
        {},
        deskToken,
      ).expect(201);
    });

    it('PD-075 ficha inexistente o absorbida: no se registra nada; la superviviente lista y revoca la de la absorbida', async () => {
      const missing = await grant(randomUUID(), { purpose: 'PHOTOS' }).expect(
        404,
      );
      expect((missing.body as Problem).code).toBe('DATA_SUBJECT_NOT_FOUND');

      const { survivor, absorbed } = await mergedPair();
      const ofAbsorbed = (
        await grant(absorbed.id, { purpose: 'RESEARCH' }).expect(201)
      ).body as AuthorizationBody;
      await merge(absorbed.id, survivor.id);

      const merged = await grant(absorbed.id, { purpose: 'PHOTOS' }).expect(
        409,
      );
      expect((merged.body as Problem).code).toBe('PATIENT_MERGED');

      const list = (
        await get(`/patients/${survivor.id}/authorizations`, deskToken).expect(
          200,
        )
      ).body as { items: AuthorizationBody[] };
      expect(list.items.map((a) => a.id)).toEqual([ofAbsorbed.id]);
      await post(
        `/patients/${survivor.id}/authorizations/${ofAbsorbed.id}/revocation`,
        {},
        deskToken,
      ).expect(201);
      expect(await prisma.patientAuthorization.count()).toBe(1);
    });

    it('PD-074 registrar y revocar dejan su fila en la bitácora, y sin bitácora no se escribe', async () => {
      const patient = await chartWithContact();
      const granted = (
        await grant(patient.id, { purpose: 'PHOTOS' }).expect(201)
      ).body as AuthorizationBody;
      expect(
        await trail('patient_authorization', granted.id, 'CREATE'),
      ).toHaveLength(1);
      await post(
        `/patients/${patient.id}/authorizations/${granted.id}/revocation`,
        {},
        deskToken,
      ).expect(201);
      expect(
        await trail('patient_authorization_revocation', granted.id, 'CREATE'),
      ).toHaveLength(1);

      const restore = await refuseTrail('patient_authorization', 'CREATE');
      try {
        await grant(patient.id, { purpose: 'RESEARCH' }).expect(500);
      } finally {
        await restore();
      }
      expect(
        await prisma.patientAuthorization.count({
          where: { purpose: 'RESEARCH' },
        }),
      ).toBe(0);
    });
  });

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

    it('PD-046 una solicitud sin responder se edita —derecho, texto y recepción— y el vencimiento se recalcula, con versión', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;
      const earlier = new Date(Date.now() - 3 * DAY_MS);

      const edited = await patch(`/requests/${created.id}`, {
        right: 'PORTABILITY',
        description: 'Mis datos en un archivo para otra clínica',
        receivedAt: earlier.toISOString(),
      }).expect(200);
      const body = edited.body as RequestBody;
      expect(body).toMatchObject({
        right: 'PORTABILITY',
        description: 'Mis datos en un archivo para otra clínica',
        receivedAt: earlier.toISOString(),
        dueOn: legalDueDate('PORTABILITY', clinicalDateOf(earlier), new Set()),
        changedBy: { id: officerId },
      });
      // Control: la fecha nueva es la que lo movió.
      expect(body.dueOn).not.toBe(created.dueOn);

      const versions = await prisma.recordVersion.findMany({
        where: { resourceType: 'data_subject_request', resourceId: created.id },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.data).toMatchObject({ right: 'ACCESS' });
      expect(
        await trail('data_subject_request', created.id, 'UPDATE'),
      ).toHaveLength(1);
    });

    it('PD-046 dos ediciones a la vez —una cambia el derecho, otra la recepción— se aplican las dos y el vencimiento sale de lo que quedó', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;
      const earlier = new Date(Date.now() - 3 * DAY_MS);

      // Un tercero sostiene el candado de la fila: las dos ediciones leen la
      // solicitud como estaba y esperan, las dos, a escribir.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM data_subject_request
             WHERE id = ${created.id}::uuid FOR UPDATE`;
          await released;
        },
        { timeout: 20_000 },
      );
      const toSuspension = patch(`/requests/${created.id}`, {
        right: 'SUSPENSION',
      }).then((response) => response);
      const toEarlier = patch(`/requests/${created.id}`, {
        receivedAt: earlier.toISOString(),
      }).then((response) => response);
      await waitForLockWaiters(2);
      release();
      await holder;
      const responses = await Promise.all([toSuspension, toEarlier]);

      // Las dos ganan, una detrás de otra.
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.right).toBe('SUSPENSION');
      expect(stored.receivedAt.toISOString()).toBe(earlier.toISOString());
      // Y el vencimiento es el del derecho y la recepción que quedaron, no el
      // que cada una calculó con lo que leyó antes del candado.
      const listed = (await get(`/patients/${patient.id}/requests`).expect(200))
        .body as RequestBody[] | { items: RequestBody[] };
      const final = (Array.isArray(listed) ? listed : listed.items).find(
        (entry) => entry.id === created.id,
      );
      expect(final?.dueOn).toBe(
        legalDueDate('SUSPENSION', clinicalDateOf(earlier), new Set()),
      );
    });

    it('PD-046 cambiar sólo lo que pide no mueve el vencimiento', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;

      const edited = await patch(`/requests/${created.id}`, {
        description: 'Copia de mis datos y de mis consentimientos',
      }).expect(200);
      expect((edited.body as RequestBody).dueOn).toBe(created.dueOn);
    });

    it('PD-046 la respondida no se edita, ni una recepción futura entra', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ACCESS' }).expect(201)
      ).body as RequestBody;

      const future = await patch(`/requests/${created.id}`, {
        receivedAt: new Date(Date.now() + DAY_MS).toISOString(),
      }).expect(422);
      expect((future.body as Problem).code).toBe(
        'DATA_REQUEST_RECEIVED_IN_FUTURE',
      );

      await post(`/requests/${created.id}/response`, {
        outcome: 'GRANTED',
        response: 'Entregada',
      }).expect(200);
      const answered = await patch(`/requests/${created.id}`, {
        description: 'Otra cosa',
      }).expect(409);
      expect((answered.body as Problem).code).toBe(
        'DATA_REQUEST_ALREADY_ANSWERED',
      );
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.description).toBe('Copia de mis datos');
    });

    it('PD-047 «Corregir respuesta» emite una rectificada enlazada; la original sigue en la historia de la solicitud', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await register(patient.id, { right: 'ERASURE' }).expect(201)
      ).body as RequestBody;

      const notYet = await post(`/requests/${created.id}/response/correction`, {
        outcome: 'DENIED',
        response: 'No procede',
      }).expect(409);
      expect((notYet.body as Problem).code).toBe('DATA_REQUEST_NOT_ANSWERED');

      await post(`/requests/${created.id}/response`, {
        outcome: 'DENIED',
        response: 'No procede',
      }).expect(200);
      const first = await post(`/requests/${created.id}/response/correction`, {
        outcome: 'PARTIALLY_GRANTED',
        response:
          'Se deniega suprimir la historia clínica (LOPDP art. 18.2) y se cesan los recordatorios',
      }).expect(200);
      expect((first.body as RequestBody).answer).toMatchObject({
        outcome: 'PARTIALLY_GRANTED',
        isCorrection: true,
        answeredBy: { id: officerId },
      });
      expect(
        (first.body as RequestBody).previousAnswers.map((a) => a.response),
      ).toEqual(['No procede']);

      // Se rectifica la vigente, en cadena.
      const second = await post(`/requests/${created.id}/response/correction`, {
        outcome: 'PARTIALLY_GRANTED',
        response: 'Texto final',
      }).expect(200);
      expect(
        (second.body as RequestBody).previousAnswers.map((a) => a.outcome),
      ).toEqual(['PARTIALLY_GRANTED', 'DENIED']);

      // Nada se borró: la respuesta original sigue en su fila.
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.response).toBe('No procede');
      expect(
        await trail('data_subject_request', created.id, 'UPDATE'),
      ).toHaveLength(3);
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

    it('PD-051 las abiertas se filtran por derecho y por vencidas, y llegan por páginas con el total', async () => {
      const [a, b, c] = await Promise.all([
        createPatient(prisma),
        createPatient(prisma),
        createPatient(prisma),
      ]);
      const late = (
        await register(a.id, {
          right: 'ACCESS',
          receivedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
        }).expect(201)
      ).body as RequestBody;
      const access = (await register(b.id, { right: 'ACCESS' }).expect(201))
        .body as RequestBody;
      const rectification = (
        await register(c.id, { right: 'RECTIFICATION' }).expect(201)
      ).body as RequestBody;
      type Page = { items: RequestBody[]; total: number; pageSize: number };
      const ids = (body: unknown) => (body as Page).items.map((r) => r.id);

      // Control: without filters, all three, earliest due first.
      const all = await get('/requests').expect(200);
      expect(ids(all.body)).toEqual([late.id, access.id, rectification.id]);
      expect((all.body as Page).total).toBe(3);

      const byRight = await get('/requests?right=ACCESS').expect(200);
      expect(ids(byRight.body)).toEqual([late.id, access.id]);

      const overdue = await get('/requests?overdue=true').expect(200);
      expect(ids(overdue.body)).toEqual([late.id]);
      expect((overdue.body as Page).items[0]!.isOverdue).toBe(true);

      const second = await get('/requests?page=2&pageSize=2').expect(200);
      expect(ids(second.body)).toEqual([rectification.id]);
      expect((second.body as Page).total).toBe(3);

      await get('/requests?pageSize=101').expect(422);
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
      // Reading what the patient asked is a READ of the chart (REQ-110).
      expect(
        await trail('patient_data_requests', survivor.id, 'READ'),
      ).toHaveLength(1);
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
      const { survivor, absorbed } = await mergedPair();
      await prisma.patientIdentifier.create({
        data: { patientId: absorbed.id, type: 'PASSPORT', value: 'AB12345' },
      });
      await post(
        `/patients/${absorbed.id}/authorizations`,
        { purpose: 'PHOTOS' },
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
        authorizations: { purpose: string; revokedAt: string | null }[];
        requests: { right: string }[];
        omitted: { section: string }[];
      };
      expect(document).toMatchObject({
        format: 'clinica.privacy.export',
        formatVersion: 3,
      });
      expect(document.patient.mrn).toBe(survivor.mrn);
      expect(document.patient.mergedCharts.map((c) => c.mrn)).toEqual([
        absorbed.mrn,
      ]);
      expect(document.identifiers).toEqual([
        expect.objectContaining({ chart: absorbed.mrn, value: 'AB12345' }),
      ]);
      expect(document.authorizations).toEqual([
        expect.objectContaining({
          chart: absorbed.mrn,
          purpose: 'PHOTOS',
          revokedAt: null,
        }),
      ]);
      expect(document.requests.map((r) => r.right)).toEqual(['ACCESS']);
      expect(document.omitted.map((o) => o.section)).toEqual([
        'clinical_record',
        'sexual_orientation',
        'priority_groups',
        'contacts',
        'mother_link',
        'appointments',
        'billing',
        'record_corrections',
        'access_log',
        // PD-067. Without `record:read`, said even with nothing to leave out:
        // its absence would tell whether the chart had clinical versions.
        'clinical_versions',
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

    it('PD-048 la exportación incluye las versiones guardadas de la ficha y de sus absorbidas, con quién y cuándo; rectificar no borra ninguna', async () => {
      const { survivor, absorbed } = await mergedPair();
      const nurse = await createUser(prisma);
      const allergy = await prisma.patientAllergy.create({
        data: {
          patientId: absorbed.id,
          substanceText: 'Penicilina',
          recordedById: nurse.id,
        },
      });
      // Dos correcciones de la alergia: dos versiones (D-127). La segunda es
      // la «rectificación» del titular, que no borra la primera.
      const firstEdit = new Date(Date.now() - 2000);
      await prisma.patientAllergy.update({
        where: { id: allergy.id },
        data: {
          substanceText: 'Amoxicilina',
          changedById: nurse.id,
          changedAt: firstEdit,
        },
      });
      await prisma.patientAllergy.update({
        where: { id: allergy.id },
        data: {
          substanceText: 'Amoxicilina con clavulánico',
          changedById: officerId,
          changedAt: new Date(firstEdit.getTime() + 1000),
        },
      });
      // Un grupo prioritario editado: su versión NO sale (PA-042, D-083 §3).
      const group = await prisma.patientPriorityGroup.create({
        data: {
          patientId: survivor.id,
          groupCode: 'DISABILITY',
          startsOn: new Date(),
          origin: 'SELF_DECLARED',
          recordedById: nurse.id,
        },
      });
      await prisma.patientPriorityGroup.update({
        where: { id: group.id },
        data: {
          origin: 'ACCREDITED',
          evidenceDocument: 'Carné',
          changedById: nurse.id,
          changedAt: new Date(),
        },
      });
      // Y la de otra persona, tampoco.
      const stranger = await createPatient(prisma);
      const foreign = await prisma.patientAllergy.create({
        data: {
          patientId: stranger.id,
          substanceText: 'Látex',
          recordedById: nurse.id,
        },
      });
      await prisma.patientAllergy.update({
        where: { id: foreign.id },
        data: {
          substanceText: 'Látex natural',
          changedById: nurse.id,
          changedAt: new Date(),
        },
      });
      await merge(absorbed.id, survivor.id);
      const access = await requestFor(survivor.id, 'ACCESS');
      // PD-067 (D-203 §10). The allergies are clinical: they leave with the
      // key of the record, which this officer is given here.
      await grantToOfficer('record:read');

      const response = await get(`/requests/${access.id}/export`).expect(200);
      const document = response.body as {
        versions: {
          table: string;
          resourceId: string;
          version: number;
          changedAt: string;
          changedBy: { id: string; fullName: string };
          data: Record<string, unknown>;
        }[];
        omitted: { section: string; reason: string }[];
      };

      expect(
        document.versions.map((v) => [v.table, v.resourceId, v.version]),
      ).toEqual([
        ['patient_allergy', allergy.id, 1],
        ['patient_allergy', allergy.id, 2],
      ]);
      expect(document.versions[0]).toMatchObject({
        changedBy: { id: nurse.id },
        changedAt: firstEdit.toISOString(),
        data: { substance_text: 'Penicilina' },
      });
      expect(document.versions[1]).toMatchObject({
        changedBy: { id: officerId },
        data: { substance_text: 'Amoxicilina' },
      });
      expect(JSON.stringify(document.versions)).not.toContain('Látex');
      expect(document.omitted.map((o) => o.section)).toContain(
        'priority_groups',
      );
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

    it('PD-049 la respuesta propuesta a una de acceso dice lo que el archivo no lleva, sin escribir nada; y lo editado es lo que queda', async () => {
      const patient = await createPatient(prisma);
      const access = await requestFor(patient.id, 'ACCESS');

      const auditRows = () => prisma.accessAudit.count();
      const before = await auditRows();
      const response = await get(
        `/requests/${access.id}/answer-proposal`,
      ).expect(200);
      const proposal = (response.body as { response: string }).response;
      expect(await auditRows()).toBe(before);

      // The same list the file carries, one line per section in its order.
      const exported = await get(`/requests/${access.id}/export`).expect(200);
      // Positive control: the export does write to the trail.
      expect(await auditRows()).toBeGreaterThan(before);
      const omitted = (exported.body as { omitted: { section: string }[] })
        .omitted;
      const lines = proposal.split('\n');
      expect(lines[0]).toBe('El archivo con sus datos no lo incluye todo:');
      expect(lines).toHaveLength(omitted.length + 1);
      expect(proposal).not.toMatch(/\([A-Z]{1,3}-\d{2,3}/);
      expect(proposal).toContain(
        'Las citas, pasadas y futuras, y la lista de espera no se incluyen todavía; si se movió o corrigió alguna cita',
      );

      // PD-033. What is saved is what was written: the proposal, edited.
      const written = `${proposal}\nSe entregó en persona.`;
      await post(`/requests/${access.id}/response`, {
        outcome: 'PARTIALLY_GRANTED',
        response: written,
      }).expect(200);
      const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: access.id },
      });
      expect(stored.response).toBe(written);
    });

    it('PD-049 otro derecho no tiene propuesta, una inexistente es 404 y recepción no la pide', async () => {
      const patient = await createPatient(prisma);
      const rectification = await requestFor(patient.id, 'RECTIFICATION');
      const portability = await requestFor(patient.id, 'PORTABILITY');

      const refused = await get(
        `/requests/${rectification.id}/answer-proposal`,
      ).expect(422);
      expect((refused.body as Problem).code).toBe('DATA_EXPORT_NOT_APPLICABLE');
      await get(`/requests/${portability.id}/answer-proposal`).expect(200);
      await get(`/requests/${crypto.randomUUID()}/answer-proposal`).expect(404);
      await get(
        `/requests/${portability.id}/answer-proposal`,
        deskToken,
      ).expect(403);
    });

    it('PD-040 recepción no exporta: cerrado por defecto', async () => {
      const patient = await createPatient(prisma);
      const access = await requestFor(patient.id, 'ACCESS');
      await get(`/requests/${access.id}/export`, deskToken).expect(403);
    });
  });

  // --- D6 ------------------------------------------------------------------------

  describe('D6 la copia de la historia clínica (D-198 §1, A.M. 5216)', () => {
    const HOUR_MS = 60 * 60 * 1000;
    const copy = {
      right: 'ACCESS',
      description: 'Copia de la historia clínica',
      clinicalRecordCopy: true,
      documentsChecked: true,
    };
    const byAttorney = {
      ...copy,
      requestedBy: 'ATTORNEY',
      requesterName: 'Ana Pérez',
      requesterDocument: '1710034065',
    };

    it('PD-052 PD-053 PD-054 EN-033 un apoderado pide la copia: se guarda quién es y vence a las 48 horas de recibida', async () => {
      const patient = await createPatient(prisma);
      const receivedAt = new Date(Date.now() - 2 * HOUR_MS);

      const created = (
        await post(`/patients/${patient.id}/requests`, {
          ...byAttorney,
          receivedAt: receivedAt.toISOString(),
        }).expect(201)
      ).body as RequestBody & {
        dueAt: string;
        requestedBy: string;
        requesterName: string | null;
        requesterDocument: string | null;
        clinicalRecordCopy: boolean;
      };

      expect(new Date(created.dueAt).getTime()).toBe(
        receivedAt.getTime() + 48 * HOUR_MS,
      );
      expect(created.dueOn).toBe(
        clinicalDateOf(new Date(receivedAt.getTime() + 48 * HOUR_MS)),
      );
      expect(created).toMatchObject({
        requestedBy: 'ATTORNEY',
        requesterName: 'Ana Pérez',
        requesterDocument: '1710034065',
        clinicalRecordCopy: true,
        isOverdue: false,
      });
      const row = await prisma.dataSubjectRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.documentsChecked).toBe(true);
    });

    it('PD-054 recibida «ahora», la recepción y el registro son el mismo instante del reloj de la aplicación y vence 48 horas después, al milisegundo', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await post(`/patients/${patient.id}/requests`, byAttorney).expect(201)
      ).body as RequestBody & { dueAt: string; registeredAt: string };

      expect(created.registeredAt).toBe(created.receivedAt);
      expect(
        new Date(created.dueAt).getTime() -
          new Date(created.receivedAt).getTime(),
      ).toBe(48 * HOUR_MS);
    });

    it('PD-054 PD-035 la copia vencida hace una hora sale marcada y antes que un acceso de quince días recibido antes', async () => {
      const patient = await createPatient(prisma);
      const access = (
        await post(`/patients/${patient.id}/requests`, {
          right: 'ACCESS',
          requestedBy: 'HOLDER',
          description: 'Mis datos',
          receivedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
        }).expect(201)
      ).body as RequestBody;
      const late = (
        await post(`/patients/${patient.id}/requests`, {
          ...byAttorney,
          receivedAt: new Date(Date.now() - 49 * HOUR_MS).toISOString(),
        }).expect(201)
      ).body as RequestBody;

      const page = (await get('/requests?pageSize=100').expect(200)).body as {
        items: RequestBody[];
      };
      const ids = page.items.map((item) => item.id);
      expect(ids.indexOf(late.id)).toBeLessThan(ids.indexOf(access.id));
      expect(page.items.find((item) => item.id === late.id)!.isOverdue).toBe(
        true,
      );
      expect(page.items.find((item) => item.id === access.id)!.isOverdue).toBe(
        false,
      );

      const overdue = (
        await get('/requests?overdue=true&pageSize=100').expect(200)
      ).body as { items: RequestBody[] };
      expect(overdue.items.map((item) => item.id)).toContain(late.id);
      expect(overdue.items.map((item) => item.id)).not.toContain(access.id);
    });

    it('PD-052 un tercero que no pide la copia y el familiar de un paciente vivo se rechazan nombrando por qué, sin escribir', async () => {
      const patient = await createPatient(prisma);
      const before = await prisma.dataSubjectRequest.count();

      const notCopy = await post(`/patients/${patient.id}/requests`, {
        ...byAttorney,
        clinicalRecordCopy: false,
      }).expect(422);
      expect((notCopy.body as Problem).code).toBe(
        'DATA_REQUEST_PARTY_NOT_ALLOWED',
      );

      const relative = {
        ...copy,
        requestedBy: 'DECEASED_RELATIVE',
        requesterName: 'Luis Guamán',
        requesterDocument: '0926687856',
        requesterRelationship: 'CHILD',
      };
      const alive = await post(
        `/patients/${patient.id}/requests`,
        relative,
      ).expect(422);
      expect((alive.body as Problem).code).toBe(
        'DATA_REQUEST_PATIENT_NOT_DECEASED',
      );
      expect(await prisma.dataSubjectRequest.count()).toBe(before);

      // Control positivo: con el fallecimiento registrado en la ficha, sí.
      await prisma.patient.update({
        where: { id: patient.id },
        data: { deceasedAt: new Date(Date.now() - DAY_MS) },
      });
      await post(`/patients/${patient.id}/requests`, relative).expect(201);
    });

    it('PD-053 la copia sin la casilla, con otro derecho o sin el documento de quien la presenta se rechaza nombrando el campo', async () => {
      const patient = await createPatient(prisma);
      for (const [body, field] of [
        [{ ...byAttorney, documentsChecked: false }, 'documentsChecked'],
        [
          { ...byAttorney, requestedBy: 'HOLDER', right: 'PORTABILITY' },
          'clinicalRecordCopy',
        ],
        [{ ...byAttorney, requesterDocument: '  ' }, 'requesterDocument'],
      ] as const) {
        const response = await post(
          `/patients/${patient.id}/requests`,
          body,
        ).expect(422);
        expect(response.body as Problem).toMatchObject({
          code: 'CLINICAL_RECORD_COPY_INVALID',
          errors: [expect.objectContaining({ field })],
        });
      }
    });

    it('PD-053 PD-054 editar la recepción de una copia mueve las 48 horas; pasarla a otro derecho se rechaza', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await post(`/patients/${patient.id}/requests`, byAttorney).expect(201)
      ).body as RequestBody;
      const earlier = new Date(Date.now() - 5 * HOUR_MS);

      const edited = (
        await patch(`/requests/${created.id}`, {
          receivedAt: earlier.toISOString(),
        }).expect(200)
      ).body as RequestBody & { dueAt: string };
      expect(new Date(edited.dueAt).getTime()).toBe(
        earlier.getTime() + 48 * HOUR_MS,
      );

      const toOther = await patch(`/requests/${created.id}`, {
        right: 'RECTIFICATION',
      }).expect(422);
      expect((toOther.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_INVALID',
      );
    });

    it('PD-055 un tercero no recibe la exportación JSON; el titular que pide la copia, sí', async () => {
      const patient = await createPatient(prisma);
      const third = (
        await post(`/patients/${patient.id}/requests`, byAttorney).expect(201)
      ).body as RequestBody;
      const refused = await get(`/requests/${third.id}/export`).expect(422);
      expect((refused.body as Problem).code).toBe('DATA_EXPORT_NOT_APPLICABLE');

      const holder = (
        await post(`/patients/${patient.id}/requests`, {
          ...copy,
          requestedBy: 'HOLDER',
        }).expect(201)
      ).body as RequestBody;
      await get(`/requests/${holder.id}/export`).expect(200);
    });

    it('PD-056 PD-058 D-203 la propuesta de una copia pide la llave de la historia y dice a quién se entrega y que no lleva el tamizaje, y no escribe nada', async () => {
      const patient = await createPatient(prisma);
      const created = (
        await post(`/patients/${patient.id}/requests`, byAttorney).expect(201)
      ).body as RequestBody;
      // D-203 §1. Sin record:read, la copia no se autoriza: ni su propuesta.
      const keyless = await get(
        `/requests/${created.id}/answer-proposal`,
      ).expect(404);
      expect((keyless.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
      // Control positivo: la misma persona, con la llave de la historia.
      const officerRole = await prisma.role.findUniqueOrThrow({
        where: { code: 'PROTECCION_DATOS' },
      });
      await prisma.rolePermission.create({
        data: { roleId: officerRole.id, permissionCode: 'record:read' },
      });
      registry.invalidate();
      const trail = await prisma.accessAudit.count();

      const proposal = (
        await get(`/requests/${created.id}/answer-proposal`).expect(200)
      ).body as { response: string };

      expect(proposal.response).toContain(
        'Se autoriza la entrega de la copia certificada de la historia clínica, en PDF, a su apoderado, Ana Pérez.',
      );
      expect(proposal.response).toContain('No lleva el tamizaje de violencia');
      expect(await prisma.accessAudit.count()).toBe(trail);
    });
  });

  describe('D7 la copia como la del HCAM (D-203 §2 a §10 y §12)', () => {
    const copy = {
      right: 'ACCESS',
      description: 'Copia de la historia clínica',
      clinicalRecordCopy: true,
      documentsChecked: true,
    };
    const byAttorney = {
      ...copy,
      requestedBy: 'ATTORNEY',
      requesterName: 'Ana Pérez',
      requesterDocument: '1710034065',
    };
    type CopyBody = RequestBody & {
      canAuthorise: boolean;
      reviewRequired: boolean;
      review: { includesScreening: boolean; reviewedBy: { id: string } } | null;
      answer: {
        outcome: string;
        copyPeriod: { from: string; to: string } | null;
      } | null;
      requesterRelationship: string | null;
    };

    let site: { id: string };
    let doctor: { id: string };

    /** An account with a role, granted at one site or at all of them. */
    async function signInAs(
      account: { email: string; cedula: string },
      roleCode: string,
      permissions: string[] | null,
      siteId: string | null,
    ): Promise<{ token: string; userId: string }> {
      if (permissions) {
        const role = await prisma.role.create({
          data: { code: roleCode, name: roleCode },
        });
        await prisma.rolePermission.createMany({
          data: permissions.map((permissionCode) => ({
            roleId: role.id,
            permissionCode,
          })),
        });
        registry.invalidate();
      }
      const user = await prisma.user.create({
        data: {
          email: account.email,
          firstName: 'Rosa',
          lastName: 'Tapia',
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
        data: { userId: user.id, roleId: role.id, siteId },
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

    /** A person attended at `siteId`, with the 002 signed. */
    async function attendedAt(siteId: string, patientId?: string) {
      const patient = patientId
        ? { id: patientId }
        : await createPatient(prisma);
      const encounter = await createEncounter(prisma, {
        siteId,
        practitionerId: doctor.id,
        patientId: patient.id,
        startedAt: new Date(Date.now() - 5 * DAY_MS),
      });
      const chainId = randomUUID();
      await prisma.clinicalNote.create({
        data: {
          id: chainId,
          chainId,
          encounterId: encounter.id,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: { motivoConsulta: 'Control' },
          authorId: doctor.id,
          signedById: doctor.id,
          signedAt: new Date(Date.now() - 5 * DAY_MS),
          contentHash: 'c'.repeat(64),
        },
      });
      return { patientId: patient.id, encounterId: encounter.id };
    }

    beforeEach(async () => {
      site = await createSite(prisma, 'Sede Norte');
      doctor = await createPractitioner(prisma);
    });

    const custodian = () =>
      signInAs(
        { email: 'archivo@clinica.ec', cedula: '1710034073' },
        'CUSTODIO',
        ['patient:data-requests', 'record:read'],
        site.id,
      );
    const physician = (siteId: string | null = site.id) =>
      signInAs(
        { email: 'medica@clinica.ec', cedula: '0926687864' },
        'MEDICO',
        null,
        siteId,
      );

    it('PD-062 PD-061 PD-060 una copia para un apoderado con un diagnóstico sensible espera el visto bueno del médico; con él, se autoriza; la del titular no lo espera', async () => {
      const { token: custodianToken } = await custodian();
      const { token: doctorToken, userId: doctorUserId } = await physician();
      const { patientId, encounterId } = await attendedAt(site.id);
      await createDiagnosis(prisma, encounterId, 'B20');
      const created = (
        await post(
          `/patients/${patientId}/requests`,
          byAttorney,
          custodianToken,
        ).expect(201)
      ).body as CopyBody;
      expect(created).toMatchObject({ reviewRequired: true, canAuthorise: true, review: null }); // prettier-ignore

      const granted = { outcome: 'GRANTED', response: 'Se autoriza' };
      const waiting = await post(`/requests/${created.id}/response`, granted, custodianToken).expect(409); // prettier-ignore
      expect(waiting.body as Problem).toMatchObject({
        code: 'CLINICAL_RECORD_COPY_REVIEW_REQUIRED',
      });
      expect((waiting.body as Problem).title).not.toMatch(/VIH|B20|diagn/i);
      await expect(
        prisma.dataSubjectRequest.findUniqueOrThrow({
          where: { id: created.id },
        }),
      ).resolves.toMatchObject({ outcome: null });

      // El médico la ve en la ficha y da su visto bueno, con la casilla.
      const pending = (
        await get(`/patients/${patientId}/copy-reviews`, doctorToken).expect(
          200,
        )
      ).body as { items: CopyBody[] };
      expect(pending.items.map((item) => [item.id, item.reviewRequired])).toEqual([[created.id, true]]); // prettier-ignore
      const unchecked = await post(`/requests/${created.id}/clinical-review`, { reviewed: false }, doctorToken).expect(422); // prettier-ignore
      expect((unchecked.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_INVALID',
      );
      const reviewed =
        (await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, doctorToken).expect(200)) // prettier-ignore
        .body as CopyBody;
      expect(reviewed).toMatchObject({
        reviewRequired: false,
        review: { includesScreening: false, reviewedBy: { id: doctorUserId } },
      });
      expect(await trail('clinical_record_copy_review', created.id, 'CREATE')).toHaveLength(1); // prettier-ignore
      const twice = await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, doctorToken).expect(409); // prettier-ignore
      expect((twice.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_ALREADY_REVIEWED',
      );

      // Control positivo: con el visto bueno, el custodio la autoriza.
      await post(`/requests/${created.id}/response`, granted, custodianToken).expect(200); // prettier-ignore
      // …y la del titular, en la misma historia, no espera a nadie.
      const holder =
        (await post(`/patients/${patientId}/requests`, { ...copy, requestedBy: 'HOLDER' }, custodianToken).expect(201)) // prettier-ignore
        .body as CopyBody;
      expect(holder.reviewRequired).toBe(false);
      await post(`/requests/${holder.id}/response`, granted, custodianToken).expect(200); // prettier-ignore
    });

    it('PD-061 PD-062 un visto bueno anterior a algo sensible nuevo ya no vale: hace falta otro; y rectificar a «Atendida» también lo pide', async () => {
      const { token: custodianToken } = await custodian();
      const { token: doctorToken } = await physician();
      const { patientId, encounterId } = await attendedAt(site.id);
      await createDiagnosis(prisma, encounterId, 'C50.9');
      const created =
        (await post(`/patients/${patientId}/requests`, byAttorney, custodianToken).expect(201)) // prettier-ignore
        .body as CopyBody;
      await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, doctorToken).expect(200); // prettier-ignore
      // Después del visto bueno, otro diagnóstico sensible.
      await createDiagnosis(prisma, encounterId, 'B20.9');
      const granted = { outcome: 'GRANTED', response: 'Se autoriza' };
      const stale = await post(`/requests/${created.id}/response`, granted, custodianToken).expect(409); // prettier-ignore
      expect((stale.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_REVIEW_REQUIRED',
      );
      // Denegada, y luego rectificar a «Atendida» sin visto bueno nuevo: igual.
      await post(`/requests/${created.id}/response`, { outcome: 'DENIED', response: 'Falta' }, custodianToken).expect(200); // prettier-ignore
      await post(`/requests/${created.id}/response/correction`, granted, custodianToken).expect(409); // prettier-ignore
      // Control positivo: un visto bueno nuevo, y se rectifica.
      await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, doctorToken).expect(200); // prettier-ignore
      await post(`/requests/${created.id}/response/correction`, granted, custodianToken).expect(200); // prettier-ignore
      await expect(
        prisma.clinicalRecordCopySnapshot.count({
          where: { requestId: created.id },
        }),
      ).resolves.toBe(1);
    });

    it('PD-060 PD-062 sin la llave se deniega pero no se rectifica a «Atendida», y no se lee si la copia espera el visto bueno', async () => {
      const { patientId, encounterId } = await attendedAt(site.id);
      await createDiagnosis(prisma, encounterId, 'B20.9');
      const created = (
        await post(`/patients/${patientId}/requests`, byAttorney).expect(201)
      ).body as CopyBody;
      // El oficial de datos no tiene llave: nada delata lo sensible.
      expect(created).toMatchObject({ reviewRequired: false, review: null });
      const open = (await get('/requests?pageSize=100').expect(200)).body as { items: CopyBody[] }; // prettier-ignore
      expect(open.items.find((item) => item.id === created.id)!.reviewRequired).toBe(false); // prettier-ignore
      await post(`/requests/${created.id}/response`, { outcome: 'DENIED', response: 'No' }).expect(200); // prettier-ignore
      const rectified = await post(`/requests/${created.id}/response/correction`, { outcome: 'GRANTED', response: 'Sí' }).expect(404); // prettier-ignore
      expect((rectified.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
      // Control positivo: el custodio, con la llave, sí lo lee.
      const { token: custodianToken } = await custodian();
      const seen = (await get(`/patients/${patientId}/requests`, custodianToken).expect(200)).body as { items: CopyBody[] }; // prettier-ignore
      expect(seen.items[0]!.reviewRequired).toBe(true);
    });

    it('PD-062 un tamizaje con signos y el representante legal también esperan el visto bueno; un apoderado sin nada sensible, no', async () => {
      const { token: custodianToken } = await custodian();
      const { patientId, encounterId } = await attendedAt(site.id);
      const clear =
        (await post(`/patients/${patientId}/requests`, byAttorney, custodianToken).expect(201)) // prettier-ignore
        .body as CopyBody;
      expect(clear.reviewRequired).toBe(false);

      await prisma.violenceScreening.create({
        data: {
          encounterId,
          result: 'SUSPECTED',
          types: ['PHYSICAL'],
          actionTaken: 'Derivada a trabajo social',
          screenedById: doctor.id,
          screenedAt: new Date(),
        },
      });
      const representative = (
        await post(
          `/patients/${patientId}/requests`,
          { ...copy, requestedBy: 'REPRESENTATIVE', requesterName: 'Luis Pérez', requesterDocument: '1710000025' }, // prettier-ignore
          custodianToken,
        ).expect(201)
      ).body as CopyBody;
      expect(representative.reviewRequired).toBe(true);
      const refused = await post(`/requests/${representative.id}/response`, { outcome: 'GRANTED', response: 'Sí' }, custodianToken).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_REVIEW_REQUIRED',
      );
    });

    it('PD-061 sin record:protected en la sede de la persona el visto bueno responde como a una solicitud inexistente; sin el permiso, 403', async () => {
      const { token: custodianToken } = await custodian();
      const elsewhere = await createSite(prisma, 'Sede Sur');
      const { token: farDoctor } = await physician(elsewhere.id);
      const { patientId } = await attendedAt(site.id);
      const created =
        (await post(`/patients/${patientId}/requests`, byAttorney, custodianToken).expect(201)) // prettier-ignore
        .body as CopyBody;
      const missing = (await post(`/requests/${randomUUID()}/clinical-review`, { reviewed: true }, farDoctor).expect(404)).body as Problem; // prettier-ignore
      const far = (await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, farDoctor).expect(404)).body as Problem; // prettier-ignore
      expect([far.code, far.title]).toEqual([missing.code, missing.title]);
      expect(
        ((await get(`/patients/${patientId}/copy-reviews`, farDoctor).expect(200)).body as { items: unknown[] }).items, // prettier-ignore
      ).toEqual([]);
      await post(`/requests/${created.id}/clinical-review`, { reviewed: true }, deskToken).expect(403); // prettier-ignore
      await expect(prisma.clinicalRecordCopyReview.count()).resolves.toBe(0);
    });

    it('PD-059 PD-060 sin record:read se deniega pero no se autoriza; «Atendida en parte» pide su periodo y lo guarda', async () => {
      const { token: custodianToken } = await custodian();
      const { patientId } = await attendedAt(site.id);
      const first = (
        await post(`/patients/${patientId}/requests`, byAttorney).expect(201)
      ).body as CopyBody;
      // El oficial de datos no tiene record:read: lo ve, no lo autoriza.
      expect(first.canAuthorise).toBe(false);
      const listed = (await get(`/patients/${patientId}/requests`).expect(200)).body as { items: CopyBody[] }; // prettier-ignore
      expect(listed.items[0]!.canAuthorise).toBe(false);
      const open = (await get('/requests?pageSize=100').expect(200)).body as { items: CopyBody[] }; // prettier-ignore
      expect(
        open.items.find((item) => item.id === first.id)!.canAuthorise,
      ).toBe(false);
      await post(`/requests/${first.id}/response`, { outcome: 'GRANTED', response: 'Sí' }).expect(404); // prettier-ignore
      const denied =
        (await post(`/requests/${first.id}/response`, { outcome: 'DENIED', response: 'Falta el poder' }).expect(200)) // prettier-ignore
        .body as CopyBody;
      expect(denied.answer?.outcome).toBe('DENIED');
      // Y el custodio, con la llave, sí puede.
      const seen = (await get(`/patients/${patientId}/requests`, custodianToken).expect(200)).body as { items: CopyBody[] }; // prettier-ignore
      expect(seen.items[0]!.canAuthorise).toBe(true);

      const second =
        (await post(`/patients/${patientId}/requests`, byAttorney, custodianToken).expect(201)) // prettier-ignore
        .body as CopyBody;
      const today = clinicalDateOf(new Date());
      const tooLong = await post(
        `/requests/${second.id}/response`,
        { outcome: 'PARTIALLY_GRANTED', response: 'En parte', copyPeriod: { from: addDays(today, -10), to: addDays(today, 1) } }, // prettier-ignore
        custodianToken,
      ).expect(422);
      expect(tooLong.body as Problem).toMatchObject({
        code: 'CLINICAL_RECORD_COPY_INVALID',
        errors: [expect.objectContaining({ field: 'copyPeriod' })],
      });
      await post(`/requests/${second.id}/response`, { outcome: 'PARTIALLY_GRANTED', response: 'En parte' }, custodianToken).expect(422); // prettier-ignore
      const period = { from: addDays(today, -10), to: today };
      const partial =
        (await post(`/requests/${second.id}/response`, { outcome: 'PARTIALLY_GRANTED', response: 'En parte', copyPeriod: period }, custodianToken).expect(200)) // prettier-ignore
        .body as CopyBody;
      expect(partial.answer).toMatchObject({ outcome: 'PARTIALLY_GRANTED', copyPeriod: period }); // prettier-ignore
      // Rectificada a «Atendida», la copia completa: sin periodo.
      const whole =
        (await post(`/requests/${second.id}/response/correction`, { outcome: 'GRANTED', response: 'Completa' }, custodianToken).expect(200)) // prettier-ignore
        .body as CopyBody;
      expect(whole.answer).toMatchObject({
        outcome: 'GRANTED',
        copyPeriod: null,
      });
    });

    it('PD-063 PD-065 el familiar dice su parentesco; «El paciente» con la ficha fallecida se rechaza y su representante no', async () => {
      const patient = await createPatient(prisma);
      await prisma.patient.update({
        where: { id: patient.id },
        data: { deceasedAt: new Date(Date.now() - DAY_MS) },
      });
      const relative = {
        ...copy,
        requestedBy: 'DECEASED_RELATIVE',
        requesterName: 'Luis Guamán',
        requesterDocument: '0926687856',
      };
      const before = await prisma.dataSubjectRequest.count();
      const noKin = await post(`/patients/${patient.id}/requests`, relative).expect(422); // prettier-ignore
      expect(noKin.body as Problem).toMatchObject({
        code: 'CLINICAL_RECORD_COPY_INVALID',
        errors: [expect.objectContaining({ field: 'requesterRelationship' })],
      });
      const holder = await post(`/patients/${patient.id}/requests`, { ...copy, requestedBy: 'HOLDER' }).expect(422); // prettier-ignore
      expect((holder.body as Problem).code).toBe(
        'DATA_REQUEST_PATIENT_DECEASED',
      );
      expect(await prisma.dataSubjectRequest.count()).toBe(before);

      const kin =
        (await post(`/patients/${patient.id}/requests`, { ...relative, requesterRelationship: 'STEPPARENT' }).expect(201)) // prettier-ignore
        .body as CopyBody;
      expect(kin.requesterRelationship).toBe('STEPPARENT');
      await post(
        `/patients/${patient.id}/requests`,
        { ...copy, requestedBy: 'REPRESENTATIVE', requesterName: 'Ana Guamán', requesterDocument: '1710000025' }, // prettier-ignore
      ).expect(201);
    });

    it('PD-066 la exportación v2 dice a quién se entregó cada copia, con su clase, alcance y propósito; de la autoridad sólo nombre y oficio', async () => {
      const { token: custodianToken } = await custodian();
      const { patientId } = await attendedAt(site.id);
      const attorney = (await post(`/patients/${patientId}/requests`, byAttorney, custodianToken).expect(201)).body as CopyBody; // prettier-ignore
      const authority = (
        await post(
          `/patients/${patientId}/requests`,
          { ...copy, requestedBy: 'AUTHORITY', requesterName: 'Juzgado Primero', requesterDocument: 'Oficio 77', description: 'Proceso 0912-2026 por agresión' }, // prettier-ignore
          custodianToken,
        ).expect(201)
      ).body as CopyBody;
      const today = clinicalDateOf(new Date());
      await post(`/requests/${attorney.id}/response`, { outcome: 'GRANTED', response: 'Sí' }, custodianToken).expect(200); // prettier-ignore
      await post(
        `/requests/${authority.id}/response`,
        { outcome: 'PARTIALLY_GRANTED', response: 'En parte', copyPeriod: { from: addDays(today, -30), to: today } }, // prettier-ignore
        custodianToken,
      ).expect(200);
      const access =
        (await post(`/patients/${patientId}/requests`, { right: 'ACCESS', requestedBy: 'HOLDER', description: 'Mis datos' }).expect(201)) // prettier-ignore
        .body as CopyBody;

      const document = (await get(`/requests/${access.id}/export`).expect(200)).body as {
        formatVersion: number;
        deliveries: Record<string, unknown>[];
        requests: { requestedBy: string; description: string | null }[];
        versions: { table: string; data: Record<string, unknown> }[];
      }; // prettier-ignore
      expect(document.formatVersion).toBe(3);
      expect(document.deliveries).toEqual([
        expect.objectContaining({
          recipientClass: 'ATTORNEY',
          recipientName: 'Ana Pérez',
          officialLetter: null,
          scope: { kind: 'COMPLETE' },
          purpose: 'Copia de la historia clínica',
        }),
        expect.objectContaining({
          recipientClass: 'AUTHORITY',
          recipientName: 'Juzgado Primero',
          officialLetter: 'Oficio 77',
          scope: { kind: 'PERIOD', from: addDays(today, -30), to: today },
          purpose: null,
        }),
      ]);
      const text = JSON.stringify(document);
      // Ni el texto del oficio ni la cédula del apoderado, en ninguna parte.
      expect(text).not.toContain('Proceso 0912-2026');
      expect(text).not.toContain('1710034065');
      expect(document.requests.find((r) => r.requestedBy === 'AUTHORITY')!.description).toBeNull(); // prettier-ignore
      // Control positivo: las versiones de las solicitudes sí van (la respuesta las versiona).
      expect(document.versions.filter((v) => v.table === 'data_subject_request')).toHaveLength(2); // prettier-ignore
    });

    it('PD-067 las versiones clínicas sólo de las sedes del record:read de quien exporta, y omitted lo dice', async () => {
      const elsewhere = await createSite(prisma, 'Sede Sur');
      const { patientId, encounterId: here } = await attendedAt(site.id);
      const { encounterId: there } = await attendedAt(elsewhere.id, patientId);
      const nurse = await createUser(prisma);
      for (const encounterId of [here, there]) {
        await prisma.encounter.update({
          where: { id: encounterId },
          data: { visitSequence: 'SUBSEQUENT', correctedById: nurse.id, correctedAt: new Date() }, // prettier-ignore
        });
      }
      const access =
        (await post(`/patients/${patientId}/requests`, { right: 'ACCESS', requestedBy: 'HOLDER', description: 'Mis datos' }).expect(201)) // prettier-ignore
        .body as CopyBody;
      type Export = {
        versions: { table: string; resourceId: string }[];
        omitted: { section: string; reason: string }[];
      };
      const clinical = (document: Export) =>
        document.versions.filter((v) => v.table === 'encounter').map((v) => v.resourceId).sort(); // prettier-ignore

      // Sin record:read: nada clínico, y lo dice.
      const keyless = (await get(`/requests/${access.id}/export`).expect(200)).body as Export; // prettier-ignore
      expect(clinical(keyless)).toEqual([]);
      expect(keyless.omitted.find((o) => o.section === 'clinical_versions')?.reason).toContain('no tiene acceso a la historia clínica del paciente'); // prettier-ignore

      // Con record:read en la sede norte: sólo la de esa sede, y lo dice.
      const { token: custodianToken } = await custodian();
      const scoped = (await get(`/requests/${access.id}/export`, custodianToken).expect(200)).body as Export; // prettier-ignore
      expect(clinical(scoped)).toEqual([here]);
      expect(scoped.omitted.find((o) => o.section === 'clinical_versions')?.reason).toContain('otras sedes'); // prettier-ignore

      // Control positivo: con record:read en todas, las dos y sin omisión.
      await grantToOfficer('record:read');
      const whole = (await get(`/requests/${access.id}/export`).expect(200)).body as Export; // prettier-ignore
      expect(clinical(whole)).toEqual([here, there].sort());
      expect(whole.omitted.map((o) => o.section)).not.toContain(
        'clinical_versions',
      );
    });
  });
});
