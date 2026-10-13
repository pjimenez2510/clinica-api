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
  type RecognitionSession,
  type RecognizerEvents,
  type SpeechRecognizer,
} from '../../src/modules/assistant/application/speech-recognizer.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { BYTES_PER_MS } from '../../src/modules/assistant/domain/listening';
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
 * AS-240 to AS-244 (B3) by HTTP and over the audio channel, with real
 * sessions, the seed's roles and PostgreSQL. The recogniser is a fake that
 * confirms one line per second of audio, each saying the second it starts at.
 */
const PASSWORD = 'el caballo come alfalfa';
const ORIGIN = 'http://localhost:3391';

class SecondRecognizer implements SpeechRecognizer {
  open(events: RecognizerEvents): Promise<RecognitionSession> {
    let held: { startMs: number; endMs: number } | null = null;
    let open = true;
    const confirm = () => {
      if (held) events.onSegment({ ...held, text: `Línea del segundo ${held.startMs / 1000}.` }); // prettier-ignore
      held = null;
    };
    return Promise.resolve({
      send: (frame) => {
        if (!open) return false;
        if (frame.offsetMs % 1_000 === 0) confirm();
        held = {
          startMs: held?.startMs ?? frame.offsetMs,
          endMs: frame.offsetMs + frame.pcm.length / BYTES_PER_MS,
        };
        return true;
      },
      end: () => {
        confirm();
        open = false;
        return Promise.resolve();
      },
      abort: () => {
        open = false;
      },
    });
  }
}

describe('la escucha de la preparación (AS-240 a AS-244)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let wsBase: string;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let nurse: { token: string; userId: string };
  let receptionToken: string;
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
        .useValue(new SecondRecognizer())
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
    await enableAssistant(prisma, siteId);
    patientId = (await createPatient(prisma)).id;
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    nurse = await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283');
    receptionToken = (await signIn('RECEPCION', 'recepcion@clinica.ec', '0602910945')).token; // prettier-ignore
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
        firstName: 'Carmen',
        lastName: 'Salazar',
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

  const discharge = (id: string) =>
    prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${id}::uuid`; // prettier-ignore

  const url = (id: string, path: string) => `/api/v1/encounters/${id}/assistant/${path}`; // prettier-ignore
  const ticketFor = (id: string, token: string) =>
    request(app.getHttpServer()).post(url(id, 'preparation-listening/ticket')).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const readAs = (id: string, token: string, path = 'preparation-listening') =>
    request(app.getHttpServer()).get(url(id, path)).set('Authorization', `Bearer ${token}`); // prettier-ignore

  /** A channel as the browser opens it, with the messages it receives. */
  async function channel() {
    const socket = new WebSocket(`${wsBase}${LISTENING_PATH}`, { origin: ORIGIN }); // prettier-ignore
    const inbox: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = []; // prettier-ignore
    const closing = new Promise<number>((resolve) =>
      socket.on('close', (code) => resolve(code)),
    );
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
      else inbox.push(message);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const index = inbox.findIndex((m) => m.type === type);
        if (index >= 0) resolve(inbox.splice(index, 1)[0]!);
        else waiters.push({ type, resolve });
      });
    return {
      socket,
      next,
      closing,
      send: (message: object) => socket.send(JSON.stringify(message)),
      speak: (fromMs: number, ms: number) => {
        for (let at = fromMs; at < fromMs + ms; at += 100) {
          const frame = Buffer.alloc(4 + 100 * BYTES_PER_MS, 1);
          frame.writeUInt32LE(at, 0);
          socket.send(frame);
        }
      },
    };
  }

  async function listen(ticket: string) {
    const ch = await channel();
    ch.send({ type: 'hello', ticket });
    await ch.next('ready');
    ch.send({ type: 'start', device: 'computador' });
    await ch.next('listening');
    return ch;
  }

  async function preparationTicket(token = nurse.token) {
    const response = await ticketFor(encounterId, token).expect(200);
    return (response.body as { ticket: string }).ticket;
  }

  describe('quién escucha la preparación (AS-240)', () => {
    it('AS-240 gives the nurse a ticket without being the attention’s professional, and trails it apart', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);

      await ticketFor(encounterId, nurse.token).expect(200);

      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'assistant_preparation_listening', resourceId: encounterId, action: 'CREATE', userId: nurse.userId } }), // prettier-ignore
      ).toBe(1);
      // Control: the consultation's ticket is still its professional's only.
      await request(app.getHttpServer()).post(url(encounterId, 'listening/ticket')).set('Authorization', `Bearer ${nurse.token}`).expect(403); // prettier-ignore
    });

    it('AS-240 refuses without the authorization to record, and gives it with it', async () => {
      const refused = await ticketFor(encounterId, nurse.token).expect(409);
      expect((refused.body as { code: string }).code).toBe(
        'ASSISTANT_RECORDING_NOT_AUTHORIZED',
      );

      await authorizeRecording(prisma, patientId, doctor.userId);
      await ticketFor(encounterId, nurse.token).expect(200);
    });

    it('AS-240 refuses reception (no dictation permission), another site, and an attention that no longer takes content', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      await ticketFor(encounterId, receptionToken).expect(403);
      // Control: the doctor takes the vitals too.
      await ticketFor(encounterId, doctor.token).expect(200);

      const elsewhere = await createSite(prisma, 'Sede Norte');
      await enableAssistant(prisma, elsewhere.id);
      const other = await createEncounter(prisma, { siteId: elsewhere.id, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
      const missing = await ticketFor(other.id, nurse.token).expect(404);
      expect((missing.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND'); // prettier-ignore

      await discharge(encounterId);
      const closed = await ticketFor(encounterId, nurse.token).expect(409);
      expect((closed.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_CLOSED'); // prettier-ignore
    });
  });

  describe('lo oído, aparte de la consulta (AS-241 a AS-243)', () => {
    it('AS-241 AS-243 keeps what the preparation heard in its own scope, and shows it to whoever prepares', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      const ch = await listen(await preparationTicket());
      ch.speak(0, 3_000);
      ch.send({ type: 'stop' });
      await ch.next('stopped');
      ch.socket.close();

      const read = await readAs(encounterId, nurse.token).expect(200);
      expect(read.headers['cache-control']).toBe('no-store');
      const body = read.body as { segments: { startMs: number; text: string }[]; recordingAuthorized: boolean; session: { state: string } }; // prettier-ignore
      expect(body.session.state).toBe('STOPPED');
      expect(body.recordingAuthorized).toBe(true);
      expect(body.segments.map((s) => s.startMs)).toEqual([0, 1_000, 2_000]);
      expect(await prisma.transcriptSegment.count({ where: { encounterId, scope: 'PREPARATION' } })).toBe(3); // prettier-ignore
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'assistant_preparation_listening', resourceId: encounterId, action: 'READ' } }), // prettier-ignore
      ).toBe(1);
    });

    it('AS-242 the consultation does not see the preparation, nor its listening continues it, nor a draft is asked for', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      const prep = await listen(await preparationTicket());
      prep.speak(0, 2_000);
      prep.send({ type: 'stop' });
      await prep.next('stopped');
      prep.socket.close();

      const consultation = await readAs(encounterId, doctor.token, 'listening').expect(200); // prettier-ignore
      expect(consultation.body).toMatchObject({ session: null, segments: [] });

      // Control: the consultation's own listening starts at zero and is seen.
      const ticket = (await request(app.getHttpServer()).post(url(encounterId, 'listening/ticket')).set('Authorization', `Bearer ${doctor.token}`).expect(200)).body as { ticket: string }; // prettier-ignore
      const ch = await channel();
      ch.send({ type: 'hello', ticket: ticket.ticket });
      expect(await ch.next('ready')).toMatchObject({
        offsetMs: 0,
        state: null,
      });
      ch.socket.close();
      expect(await prisma.noteDraft.count({ where: { encounterId } })).toBe(0);
    });

    it('AS-243 answers 404 to a nurse of another site and 403 to reception', async () => {
      const elsewhere = await createSite(prisma, 'Sede Sur');
      await enableAssistant(prisma, elsewhere.id);
      const other = await createEncounter(prisma, { siteId: elsewhere.id, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
      await readAs(other.id, nurse.token).expect(404);
      await readAs(encounterId, receptionToken).expect(403);
      // Control: the same nurse reads the attention of her site.
      const own = await readAs(encounterId, nurse.token).expect(200);
      expect(own.body).toMatchObject({ recordingAuthorized: false, segments: [] }); // prettier-ignore
    });
  });

  describe('se detiene sola (AS-244)', () => {
    it('AS-244 revoking the authorization with the preparation open stops it and closes the channel', async () => {
      const authorization = await authorizeRecording(prisma, patientId, doctor.userId); // prettier-ignore
      const ch = await listen(await preparationTicket());
      ch.speak(0, 1_000);

      await prisma.patientAuthorizationRevocation.create({
        data: { authorizationId: authorization.id, revokedAt: new Date(), revokedBy: doctor.userId }, // prettier-ignore
      });

      expect(await ch.next('stopped')).toMatchObject({ reason: 'ASSISTANT_RECORDING_NOT_AUTHORIZED' }); // prettier-ignore
      expect(await ch.closing).toBe(4409);
    });

    it('AS-244 discharging the attention stops the preparation', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      const ch = await listen(await preparationTicket());

      await discharge(encounterId);

      expect(await ch.next('stopped')).toMatchObject({ reason: 'ASSISTANT_ENCOUNTER_CLOSED' }); // prettier-ignore
      expect(await ch.closing).toBe(4409);
    });
  });
});
