import type { AddressInfo } from 'node:net';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import {
  SPEECH_RECOGNIZER,
  type SpeechRecognizer,
} from '../../src/modules/assistant/application/speech-recognizer.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import {
  LISTENING_GATEWAY_OPTIONS,
  LISTENING_PATH,
} from '../../src/modules/assistant/infrastructure/listening.gateway';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  authorizeRecording,
  createEncounter,
  createPatient,
  createSite,
  enableAssistant,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * A3 (AS-160 to AS-169) with real sessions, the seed's roles and PostgreSQL:
 * the per-site switch and the patient's authorization to record. The
 * recogniser is a fake that never confirms a segment — the switch and the
 * authorization decide before anything is heard.
 */
const PASSWORD = 'el caballo come alfalfa';
const ORIGIN = 'http://localhost:3261';

const silentRecognizer: SpeechRecognizer = {
  open: () =>
    Promise.resolve({
      send: () => true,
      end: () => Promise.resolve(),
      abort: () => undefined,
    }),
};

describe('el asistente por sede y la autorización de grabar (A3)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let wsBase: string;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let reception: { token: string; userId: string };
  let admin: { token: string; userId: string };
  let patientId: string;
  let encounterId: string;

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
            Promise.resolve({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }), // prettier-ignore
        })
        .overrideProvider(ASSISTANT_ENABLED)
        .useValue(true)
        .overrideProvider(SPEECH_RECOGNIZER)
        .useValue(silentRecognizer)
        .overrideProvider(LISTENING_GATEWAY_OPTIONS)
        .useValue({ origins: [ORIGIN], helloWaitMs: 300, liveCheckMs: 200 })
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }); // prettier-ignore
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
      const { port } = app.getHttpServer().address() as AddressInfo;
      wsBase = `ws://127.0.0.1:${port}`;
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
    patientId = (await createPatient(prisma)).id;
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    reception = await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856'); // prettier-ignore
    admin = await signIn('ADMIN', 'admin@clinica.ec', '1104637283');
    encounterId =
      (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId })) // prettier-ignore
      .id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(roleCode: string, email: string, cedula: string) {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Luis',
        lastName: 'Mora',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({ data: { userId: user.id } }); // prettier-ignore
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id, siteId } }); // prettier-ignore
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
      practitionerId: practitioner.id,
    };
  }

  const as = (token: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`), // prettier-ignore
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer()).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body), // prettier-ignore
    put: (path: string, body: object) =>
      request(app.getHttpServer()).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body), // prettier-ignore
  });
  const assistant = (path = '') =>
    `/encounters/${encounterId}/assistant${path}`;
  const codeOf = (response: request.Response) =>
    (response.body as { code?: string }).code;

  /** A channel as the browser opens it, with the messages it receives. */
  async function listeningChannel() {
    const ticket = await as(doctor.token).post(assistant('/listening/ticket')).expect(200); // prettier-ignore
    const socket = new WebSocket(`${wsBase}${LISTENING_PATH}`, { origin: ORIGIN }); // prettier-ignore
    const inbox: Record<string, unknown>[] = [];
    const closing = new Promise<number>((resolve) =>
      socket.on('close', (code) => resolve(code)),
    );
    socket.on('message', (data: Buffer) =>
      inbox.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const next = async (type: string) => {
      await expect.poll(() => inbox.some((m) => m.type === type)).toBe(true);
      return inbox.find((m) => m.type === type)!;
    };
    socket.send(JSON.stringify({ type: 'hello', ticket: (ticket.body as { ticket: string }).ticket })); // prettier-ignore
    await next('ready');
    socket.send(JSON.stringify({ type: 'start', device: 'computador' }));
    await next('listening');
    return { next, closing };
  }

  describe('el interruptor de la sede (AS-160 a AS-163)', () => {
    it('AS-160 a new site is born with the assistant off, and the column admits switching it on', async () => {
      const stored = await prisma.siteParameter.findUniqueOrThrow({ where: { siteId } }); // prettier-ignore
      expect(stored.assistantEnabled).toBe(false);
      // Control: the same row takes the value through the same column.
      await enableAssistant(prisma, siteId);
      const on = await prisma.siteParameter.findUniqueOrThrow({ where: { siteId } }); // prettier-ignore
      expect(on.assistantEnabled).toBe(true);
    });

    it('AS-160 administration reads and changes it with the site parameters, and the change is trailed', async () => {
      const read = await as(admin.token).get(`/configuration/sites/${siteId}/parameters`).expect(200); // prettier-ignore
      expect(read.body).toMatchObject({ assistantEnabled: false, assistantAvailable: true }); // prettier-ignore

      const saved = await as(admin.token).put(`/configuration/sites/${siteId}/parameters`, { assistantEnabled: true }).expect(200); // prettier-ignore
      expect(saved.body).toMatchObject({ assistantEnabled: true, assistantAvailable: true }); // prettier-ignore
      const [trail] = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration', resourceId: siteId },
        select: { before: true, after: true },
      });
      expect(trail?.before).toMatchObject({ assistantEnabled: false });
      expect(trail?.after).toMatchObject({ assistantEnabled: true });
      // Reception, without `settings:manage`, does not change it.
      await as(reception.token).put(`/configuration/sites/${siteId}/parameters`, { assistantEnabled: false }).expect(403); // prettier-ignore
    });

    it('AS-161 every assistant route answers 404 on an attention of a site switched off, and answers again once it is on', async () => {
      const reads = ['/diagnoses', '/listening', '/note-draft', '/note-questions', '/orders', '/prescription']; // prettier-ignore
      for (const path of reads) {
        const off = await as(doctor.token).get(assistant(path));
        expect([path, off.status, codeOf(off)]).toEqual([path, 404, 'ASSISTANT_ENCOUNTER_NOT_FOUND']); // prettier-ignore
      }
      const reading = await as(doctor.token).post(assistant('/diagnoses/read'));
      expect(reading.status).toBe(404);
      const ticket = await as(doctor.token).post(
        assistant('/listening/ticket'),
      );
      expect(ticket.status).toBe(404);
      expect(await prisma.aiRun.count()).toBe(0);
      expect(await prisma.aiSuggestion.count()).toBe(0);

      // Control: the same doctor, the same attention, the site on.
      await enableAssistant(prisma, siteId);
      for (const path of reads) {
        const on = await as(doctor.token).get(assistant(path));
        expect([path, on.status]).toEqual([path, 200]);
      }
    });

    it('AS-162 tells the sites of the caller reach with the assistant on, not those out of reach', async () => {
      await enableAssistant(prisma, siteId);
      const elsewhere = (await createSite(prisma, 'Sede Sur')).id;
      await enableAssistant(prisma, elsewhere);
      await createSite(prisma, 'Sede Norte');

      const sites = await as(reception.token).get('/configuration/assistant-sites').expect(200); // prettier-ignore
      expect(sites.body).toEqual({ siteIds: [siteId] });
    });

    it('AS-163 switching the site off with the listening open stops it and closes the channel', async () => {
      await enableAssistant(prisma, siteId);
      await authorizeRecording(prisma, patientId, reception.userId);
      const ch = await listeningChannel();

      await prisma.siteParameter.update({ where: { siteId }, data: { assistantEnabled: false } }); // prettier-ignore

      expect(await ch.next('stopped')).toMatchObject({ reason: 'ASSISTANT_ENCOUNTER_NOT_FOUND' }); // prettier-ignore
      expect(await ch.closing).toBe(4409);
      const session = await prisma.listeningSession.findUnique({ where: { encounterId } }); // prettier-ignore
      expect(session?.state).toBe('STOPPED');
    });
  });

  describe('la autorización de grabar (AS-164 a AS-169)', () => {
    beforeEach(async () => {
      await enableAssistant(prisma, siteId);
    });

    it('AS-164 the base admits ASSISTANT_RECORDING without a channel, not with one, and one standing per person', async () => {
      await expect(
        prisma.patientAuthorization.create({ data: { patientId, purpose: 'ASSISTANT_RECORDING', channel: 'WHATSAPP', recordedAt: new Date(), recordedBy: reception.userId } }), // prettier-ignore
      ).rejects.toThrow(/patient_authorization_channel_matches_purpose/);
      // Control: without a channel it enters.
      await authorizeRecording(prisma, patientId, reception.userId);
      await expect(
        authorizeRecording(prisma, patientId, reception.userId),
      ).rejects.toThrow(/Unique constraint/);
    });

    it('AS-164 reception records it and revokes it on the chart like the other authorizations', async () => {
      const granted = await as(reception.token)
        .post(`/privacy/patients/${patientId}/authorizations`, {
          purpose: 'ASSISTANT_RECORDING',
          channel: null,
        }) // prettier-ignore
        .expect(201);
      const id = (granted.body as { id: string }).id;
      expect(granted.body).toMatchObject({ purpose: 'ASSISTANT_RECORDING', channel: null }); // prettier-ignore
      await as(reception.token).post(`/privacy/patients/${patientId}/authorizations/${id}/revocation`).expect(201); // prettier-ignore
    });

    it('AS-165 AS-167 without it the ticket is refused and the read says so; with it the ticket is given', async () => {
      const read = await as(doctor.token)
        .get(assistant('/listening'))
        .expect(200);
      expect(read.body).toMatchObject({ recordingAuthorized: false });
      const refused = await as(doctor.token).post(assistant('/listening/ticket')).expect(409); // prettier-ignore
      expect(codeOf(refused)).toBe('ASSISTANT_RECORDING_NOT_AUTHORIZED');
      expect(refused.body).toMatchObject({ title: 'El paciente no ha autorizado grabar la consulta para el asistente' }); // prettier-ignore

      // Control: authorized, the same route gives the ticket.
      await authorizeRecording(prisma, patientId, reception.userId);
      await as(doctor.token).post(assistant('/listening/ticket')).expect(200);
      const again = await as(doctor.token).get(assistant('/listening')).expect(200); // prettier-ignore
      expect(again.body).toMatchObject({ recordingAuthorized: true });
    });

    it('AS-165 an attention of a chart merged later reads the authorization of the surviving one', async () => {
      const survivor = await createPatient(prisma);
      await prisma.patient.update({ where: { id: patientId }, data: { mergedIntoId: survivor.id, mergedAt: new Date() } }); // prettier-ignore
      await as(doctor.token).post(assistant('/listening/ticket')).expect(409);

      await authorizeRecording(prisma, survivor.id, reception.userId);
      await as(doctor.token).post(assistant('/listening/ticket')).expect(200);
    });

    it('AS-166 revoking it with the listening open stops it and closes the channel', async () => {
      const authorization = await authorizeRecording(prisma, patientId, reception.userId); // prettier-ignore
      const ch = await listeningChannel();

      await prisma.patientAuthorizationRevocation.create({
        data: { authorizationId: authorization.id, revokedAt: new Date(), revokedBy: reception.userId }, // prettier-ignore
      });

      expect(await ch.next('stopped')).toMatchObject({ reason: 'ASSISTANT_RECORDING_NOT_AUTHORIZED' }); // prettier-ignore
      expect(await ch.closing).toBe(4409);
    });

    it('AS-168 the attention own professional records it once, trailed', async () => {
      const recorded = await as(doctor.token).post(assistant('/listening/authorization')).expect(200); // prettier-ignore
      expect(recorded.body).toEqual({ recordingAuthorized: true });
      await as(doctor.token).post(assistant('/listening/authorization')).expect(200); // prettier-ignore

      const rows = await prisma.patientAuthorization.findMany({ where: { patientId, purpose: 'ASSISTANT_RECORDING' } }); // prettier-ignore
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recordedBy).toBe(doctor.userId);
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'patient_authorization', resourceId: rows[0]!.id, action: 'CREATE', userId: doctor.userId } }), // prettier-ignore
      ).toBe(1);
      await as(doctor.token).post(assistant('/listening/ticket')).expect(200);
    });

    it('AS-168 another doctor, reception and a closed attention do not record it', async () => {
      const second = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
      const theirs = await as(second.token).post(assistant('/listening/authorization')); // prettier-ignore
      expect(codeOf(theirs)).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER');
      await as(reception.token).post(assistant('/listening/authorization')).expect(403); // prettier-ignore
      await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounterId}::uuid`; // prettier-ignore
      const closed = await as(doctor.token).post(assistant('/listening/authorization')); // prettier-ignore
      expect(codeOf(closed)).toBe('ASSISTANT_ENCOUNTER_CLOSED');
      expect(await prisma.patientAuthorization.count()).toBe(0);
    });

    it('AS-169 the functions that read the note answer without the authorization; the draft and the questions, which read the conversation, do not', async () => {
      for (const path of [
        '/diagnoses',
        '/orders',
        '/prescription',
        '/note-questions',
        '/note-draft',
      ]) {
        // prettier-ignore
        const response = await as(doctor.token).get(assistant(path));
        expect([path, response.status]).toEqual([path, 200]);
      }
      for (const path of ['/note-draft', '/note-questions']) {
        const refused = await as(doctor.token).post(assistant(path));
        expect([path, refused.status, codeOf(refused)]).toEqual([path, 409, 'ASSISTANT_RECORDING_NOT_AUTHORIZED']); // prettier-ignore
      }
      expect(await prisma.aiRun.count()).toBe(0);
      expect(await prisma.patientAuthorization.count()).toBe(0);
      // Control: authorized, the same draft route goes past the authorization
      // to its own next answer (there is no note open yet).
      await authorizeRecording(prisma, patientId, reception.userId);
      const past = await as(doctor.token).post(assistant('/note-draft'));
      expect(codeOf(past)).not.toBe('ASSISTANT_RECORDING_NOT_AUTHORIZED');
    });

    it('AS-168 from an attention of a merged chart it is recorded on the surviving one, where the chart lists it', async () => {
      const survivor = await createPatient(prisma);
      await prisma.patient.update({ where: { id: patientId }, data: { mergedIntoId: survivor.id, mergedAt: new Date() } }); // prettier-ignore

      await as(doctor.token).post(assistant('/listening/authorization')).expect(200); // prettier-ignore

      const rows = await prisma.patientAuthorization.findMany({ where: { purpose: 'ASSISTANT_RECORDING' } }); // prettier-ignore
      expect(rows.map((row) => row.patientId)).toEqual([survivor.id]);
      const listed = await as(reception.token).get(`/privacy/patients/${survivor.id}/authorizations`).expect(200); // prettier-ignore
      expect((listed.body as { items: { purpose: string }[] }).items.map((each) => each.purpose)).toContain('ASSISTANT_RECORDING'); // prettier-ignore
    });
  });
});
