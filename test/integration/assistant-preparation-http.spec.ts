import type { AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';
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
  AI_RUN_STORE,
  type AiRunStore,
} from '../../src/modules/assistant/application/ai-run.store';
import { ASSISTANT_DEMO } from '../../src/modules/assistant/application/diagnosis-proposal.service';
import { LLM_CLIENT } from '../../src/modules/assistant/application/llm-client.port';
import { PREPARATION_ASSISTANT } from '../../src/modules/assistant/application/preparation-reading.service';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
} from '../../src/modules/assistant/application/pseudonymizer.port';
import {
  SPEECH_RECOGNIZER,
  type RecognitionSession,
  type RecognizerEvents,
  type SpeechRecognizer,
} from '../../src/modules/assistant/application/speech-recognizer.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { buildLlmClient } from '../../src/modules/assistant/assistant.module';
import { PseudonymizerFailedError } from '../../src/modules/assistant/domain/assistant.errors';
import { BYTES_PER_MS } from '../../src/modules/assistant/domain/listening';
import {
  LISTENING_GATEWAY_OPTIONS,
  LISTENING_PATH,
} from '../../src/modules/assistant/infrastructure/listening.gateway';
import { DemoPseudonymizer } from '../../src/modules/assistant/infrastructure/demo/demo.pseudonymizer';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import type { Env } from '../../src/shared/config/env.schema';
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

/** AS-254. The demonstration's script answers, as with `ASSISTANT_FAKE_PROVIDER`. */
const demoConfig = {
  get: (key: keyof Env) =>
    ({
      ASSISTANT_FAKE_PROVIDER: true,
      ASSISTANT_ALLOW_REMOTE: false,
      ASSISTANT_PROVIDER_TIMEOUT_MS: 60_000,
      ASSISTANT_EXCHANGE_LOG: false,
    })[key as string],
} as unknown as ConfigService<Env, true>;

const pseudonymizer: Pseudonymizer & { current: Pseudonymizer } = {
  current: new DemoPseudonymizer(),
  pseudonymize: (input, signal) => pseudonymizer.current.pseudonymize(input, signal), // prettier-ignore
};

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
    pseudonymizer.current = new DemoPseudonymizer();

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
        .overrideProvider(ASSISTANT_DEMO)
        .useValue(true)
        .overrideProvider(PREPARATION_ASSISTANT)
        .useValue(true)
        .overrideProvider(PSEUDONYMIZER)
        .useValue(pseudonymizer)
        .overrideProvider(LLM_CLIENT)
        .useFactory({
          factory: (store: AiRunStore) => buildLlmClient(demoConfig, store),
          inject: [AI_RUN_STORE],
        })
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

  describe('la preparación termina donde empieza la consulta (AS-240, AS-244)', () => {
    it('AS-240 once the consultation is listened to, the preparation answers ASSISTANT_PREPARATION_OVER (409)', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      // Control: before the consultation, the ticket is given.
      await ticketFor(encounterId, nurse.token).expect(200);
      const now = new Date();
      await prisma.listeningSession.create({ data: { encounterId, state: 'STOPPED', offsetMs: 1_000, device: 'computador', startedBy: doctor.userId, startedAt: now, updatedAt: now } }); // prettier-ignore

      const over = await ticketFor(encounterId, nurse.token).expect(409);
      expect(over.body).toMatchObject({ code: 'ASSISTANT_PREPARATION_OVER', title: 'La consulta ya empezó a escucharse: dicte o escriba los signos' }); // prettier-ignore
    });

    it('AS-243 once the attention is closed, only its professional reads the preparation', async () => {
      await discharge(encounterId);
      const closed = await readAs(encounterId, nurse.token).expect(409);
      expect((closed.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_CLOSED'); // prettier-ignore
      // Control: the attention's professional still reads it.
      await readAs(encounterId, doctor.token).expect(200);
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

  describe('leer la preparación (AS-245 a AS-252)', () => {
    const SAID = [
      'Buenos días, ¿qué le trae por aquí?',
      'Me duele la espalda y el pecho desde ayer.',
      'Presión sistólica 120, presión diastólica 100.',
      'Talla 160, se lo midió de pie.',
    ];
    const heard = () =>
      prisma.transcriptSegment.createMany({
        data: SAID.map((text, at) => ({ encounterId, scope: 'PREPARATION', startMs: at * 3_000, endMs: at * 3_000 + 2_500, text, createdAt: new Date() })), // prettier-ignore
      });
    const readFor = (id: string, token: string) =>
      request(app.getHttpServer()).post(url(id, 'preparation-reading')).set('Authorization', `Bearer ${token}`); // prettier-ignore

    it('AS-245 AS-252 proposes each value with its phrase and who said it, writes nothing in the taking, keeps nothing, and trails the export', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      await heard();

      const response = await readFor(encounterId, nurse.token).expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({
        reader: 'assistant',
        demo: true,
        upToMs: 11_500,
        values: {
          systolicBp: { value: 120, startMs: 6_000 },
          diastolicBp: { value: 100, startMs: 6_000 },
          heightCm: { value: 160, startMs: 9_000 },
        },
        heightPosition: { value: 'STANDING', startMs: 9_000 },
        complaint: { text: 'Me duele la espalda y el pecho desde ayer.', startMs: 3_000 }, // prettier-ignore
      });
      const body = response.body as { lines: { speaker: string }[] };
      expect(body.lines.map((line) => line.speaker)).toEqual(['nursing', 'nursing', 'patient', 'nursing', 'nursing']); // prettier-ignore
      expect(await prisma.encounterVitals.findUnique({ where: { encounterId } })).toBeNull(); // prettier-ignore
      expect(await prisma.aiSuggestion.count({ where: { encounterId } })).toBe(0); // prettier-ignore
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'assistant_preparation_reading', resourceId: encounterId, action: 'EXPORT', userId: nurse.userId } }), // prettier-ignore
      ).toBe(1);

      // Control: the nurse's «Guardar», by the taking's route, does write.
      await request(app.getHttpServer()).put(`/api/v1/encounters/${encounterId}/vitals`).set('Authorization', `Bearer ${nurse.token}`).send({ systolicBp: 120, diastolicBp: 100 }).expect(200); // prettier-ignore
      expect(await prisma.encounterVitals.findUnique({ where: { encounterId } })).not.toBeNull(); // prettier-ignore
    });

    it('AS-251 reads with the rules when the pseudonymizer fails, and says so', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      await heard();
      pseudonymizer.current = { pseudonymize: () => Promise.reject(new PseudonymizerFailedError('unavailable')) }; // prettier-ignore

      const response = await readFor(encounterId, nurse.token).expect(200);

      expect(response.body).toMatchObject({
        reader: 'rules',
        demo: false,
        values: { systolicBp: { value: 120 }, diastolicBp: { value: 100 }, heightCm: { value: 160 } }, // prettier-ignore
        complaint: null,
      });
    });

    it('AS-245 refuses an empty transcript, a patient without the authorization, reception and another site', async () => {
      await authorizeRecording(prisma, patientId, doctor.userId);
      const empty = await readFor(encounterId, nurse.token).expect(422);
      expect((empty.body as { code: string }).code).toBe('ASSISTANT_TRANSCRIPT_EMPTY'); // prettier-ignore
      await heard();
      await readFor(encounterId, receptionToken).expect(403);
      // Control: the same nurse reads it once there is something said.
      await readFor(encounterId, nurse.token).expect(200);

      const unauthorized = (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId: (await createPatient(prisma)).id })).id; // prettier-ignore
      const refused = await readFor(unauthorized, nurse.token).expect(409);
      expect((refused.body as { code: string }).code).toBe('ASSISTANT_RECORDING_NOT_AUTHORIZED'); // prettier-ignore

      const elsewhere = await createSite(prisma, 'Sede Este');
      await enableAssistant(prisma, elsewhere.id);
      const other = await createEncounter(prisma, { siteId: elsewhere.id, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
      await readFor(other.id, nurse.token).expect(404);
    });
  });
});
