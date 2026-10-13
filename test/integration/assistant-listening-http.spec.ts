import { randomUUID } from 'node:crypto';
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
import { ListeningAccess } from '../../src/modules/assistant/application/listening-access';
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
import { PrismaListeningStore } from '../../src/modules/assistant/infrastructure/prisma-listening.store';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  authorizeRecording,
  createSite,
  enableAssistant,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-045 to AS-057 by HTTP and over the audio channel, with real sessions,
 * the seed's roles and PostgreSQL. The recogniser is a fake that confirms a
 * window where a sentence ends — the one thing that needs whisper; the real
 * one is measured by `pnpm listening:measure` (AS-062).
 */
const PASSWORD = 'el caballo come alfalfa';
const ORIGIN = 'http://localhost:3261';
/** E-031: where each of the six sentences starts, and where the last ends. */
const SENTENCES = [0, 4_100, 10_300, 16_700, 22_300, 28_000];
const END_MS = 32_300;

/**
 * Whisper with voice detection, as far as the clock is concerned: what it
 * holds becomes one segment when a sentence ends — the next frame starts a
 * sentence — or when it is asked to end.
 */
class SentenceRecognizer implements SpeechRecognizer {
  opened = 0;

  open(events: RecognizerEvents): Promise<RecognitionSession> {
    this.opened += 1;
    let held: { startMs: number; endMs: number } | null = null;
    let open = true;
    const confirm = () => {
      if (held)
        events.onSegment({
          ...held,
          text: `Frase que empieza en ${held.startMs}.`,
        });
      held = null;
    };
    return Promise.resolve({
      send: (frame) => {
        if (!open) return false;
        if (SENTENCES.includes(frame.offsetMs)) confirm();
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

describe('la escucha por HTTP y por su canal (AS-045 a AS-057)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let wsBase: string;
  const recognizer = new SentenceRecognizer();

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let secondDoctor: { token: string; practitionerId: string };
  let nurseToken: string;
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
        .useValue(recognizer)
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
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    encounterId =
      (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId })) // prettier-ignore
      .id;
    // AS-165. Listening needs it; A3's own spec covers its absence.
    await authorizeRecording(prisma, patientId, doctor.userId);
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

  /** The attention no longer takes new clinical content (as D1's test does it). */
  const discharge = (id: string) =>
    prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${id}::uuid`; // prettier-ignore

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/listening${path}`; // prettier-ignore
  const ticketFor = (id: string, token: string) =>
    request(app.getHttpServer()).post(url(id, '/ticket')).set('Authorization', `Bearer ${token}`); // prettier-ignore

  async function ticket(id = encounterId, token = doctor.token) {
    const response = await ticketFor(id, token).expect(200);
    return (response.body as { ticket: string }).ticket;
  }

  /** A channel as the browser opens it, with the messages it receives. */
  async function channel(origin = ORIGIN) {
    const socket = new WebSocket(`${wsBase}${LISTENING_PATH}`, { origin });
    const inbox: Record<string, unknown>[] = [];
    const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = []; // prettier-ignore
    let closed: number | null = null;
    const closing = new Promise<number>((resolve) =>
      socket.on('close', (code) => {
        closed = code;
        resolve(code);
      }),
    );
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      inbox.push(message);
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const index = inbox.findIndex((m) => m.type === type);
        if (index >= 0) resolve(inbox.splice(index, 1)[0]!);
        else waiters.push({ type, resolve: (m) => { inbox.splice(inbox.indexOf(m), 1); resolve(m); } }); // prettier-ignore
      });
    return {
      socket,
      inbox,
      next,
      closing,
      closed: () => closed,
      send: (message: object) => socket.send(JSON.stringify(message)),
      /** `ms` of audio from `fromMs`, a tenth of a second per frame. */
      speak: (fromMs: number, ms: number) => {
        for (let at = fromMs; at < fromMs + ms; at += 100) {
          const frame = Buffer.alloc(4 + 100 * BYTES_PER_MS, 1);
          frame.writeUInt32LE(at, 0);
          socket.send(frame);
        }
      },
    };
  }

  async function listening(id = encounterId) {
    const ch = await channel();
    ch.send({ type: 'hello', ticket: await ticket(id) });
    await ch.next('ready');
    ch.send({ type: 'start', device: 'computador' });
    const started = await ch.next('listening');
    return { ...ch, offsetMs: started.offsetMs as number };
  }

  describe('quién escucha (AS-045)', () => {
    it('AS-045 gives the attention own professional a single-use ticket and trails it', async () => {
      const response = await ticketFor(encounterId, doctor.token).expect(200);
      const body = response.body as { ticket: string; expiresAt: string };

      expect(body.ticket).toMatch(/^[\w-]{43}$/);
      expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
        30_000,
      );
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'assistant_listening', resourceId: encounterId, action: 'CREATE' } }), // prettier-ignore
      ).toBe(1);
    });

    it('AS-045 refuses another doctor of the same site (M-02), and the nurse without assistant:use', async () => {
      const refused = await ticketFor(encounterId, secondDoctor.token).expect(
        403,
      );
      expect((refused.body as { code: string }).code).toBe(
        'ASSISTANT_NOT_ENCOUNTER_OWNER',
      );
      await ticketFor(encounterId, nurseToken).expect(403);
      // Control: the owner of the attention gets one by the same route.
      await ticketFor(encounterId, doctor.token).expect(200);
    });

    it('AS-045 answers 404 for an attention of another site, and 409 for one that no longer takes content', async () => {
      const elsewhere = await createSite(prisma, 'Sede Norte');
      await enableAssistant(prisma, elsewhere.id);
      const other = await createEncounter(prisma, { siteId: elsewhere.id, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
      const missing = await ticketFor(other.id, doctor.token).expect(404);
      expect((missing.body as { code: string }).code).toBe(
        'ASSISTANT_ENCOUNTER_NOT_FOUND',
      );

      await discharge(encounterId);
      const closed = await ticketFor(encounterId, doctor.token).expect(409);
      expect((closed.body as { code: string }).code).toBe(
        'ASSISTANT_ENCOUNTER_CLOSED',
      );
    });
  });

  describe('el canal sin credencial en la URL (AS-046, AS-047)', () => {
    it('AS-046 opens with the ticket as first message, and refuses it a second time', async () => {
      const issued = await ticket();
      const first = await channel();
      first.send({ type: 'hello', ticket: issued });
      expect(await first.next('ready')).toEqual({
        type: 'ready',
        offsetMs: 0,
        state: null,
      });
      first.socket.close();

      const second = await channel();
      second.send({ type: 'hello', ticket: issued });
      expect(await second.closing).toBe(4401);
    });

    it('AS-046 closes with 4401 an unknown ticket, and a channel that says nothing', async () => {
      const unknown = await channel();
      unknown.send({ type: 'hello', ticket: 'x'.repeat(43) });
      expect(await unknown.closing).toBe(4401);

      const silent = await channel();
      expect(await silent.closing).toBe(4401);
    });

    it('AS-046 answers 404 and closes an upgrade to any other path, which stays open otherwise', async () => {
      const socket = new WebSocket(`${wsBase}/api/v1/encounters`);
      await expect(
        new Promise((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        }),
      ).rejects.toThrow(/404/);
      // Control: the API still answers its routes.
      await request(app.getHttpServer()).get(url(encounterId)).expect(401);
    });

    it('AS-046 refuses a browser page of another origin before opening', async () => {
      await expect(channel('https://otro-sitio.example')).rejects.toThrow(
        /403/,
      );
      // Control: the clinic's own origin opens.
      (await channel(ORIGIN)).socket.close();
    });

    it('AS-047 closes the channel with 4401 when the token it was asked with expires, and the listening pauses', async () => {
      const access = app.get(ListeningAccess);
      const { ticket: short } = await access.issue(encounterId, {
        userId: doctor.userId,
        writeSites: [siteId],
        tokenExpiresAt: new Date(Date.now() + 400),
      });
      const ch = await channel();
      ch.send({ type: 'hello', ticket: short });
      await ch.next('ready');
      ch.send({ type: 'start', device: 'computador' });
      await ch.next('listening');

      expect(await ch.closing).toBe(4401);
      await expect.poll(async () => (await prisma.listeningSession.findUnique({ where: { encounterId } }))?.reason).toBe('device-lost'); // prettier-ignore
    });

    it('AS-045 asks again on start: an attention signed after the ticket is not listened to', async () => {
      const ch = await channel();
      ch.send({ type: 'hello', ticket: await ticket() });
      await ch.next('ready');
      await discharge(encounterId);

      ch.send({ type: 'start', device: 'computador' });
      expect(await ch.next('error')).toMatchObject({
        code: 'ASSISTANT_ENCOUNTER_CLOSED',
      });
      expect(await prisma.listeningSession.count()).toBe(0);
    });
  });

  describe('la atención se cierra con la escucha abierta (AS-045, D-247 §7)', () => {
    it('AS-045 discharging the attention stops the listening, tells the channel and keeps nothing more in it', async () => {
      const ch = await listening();
      ch.speak(0, SENTENCES[1]!);
      await expect.poll(async () => (await prisma.listeningSession.findUnique({ where: { encounterId } }))?.state).toBe('LISTENING'); // prettier-ignore

      await discharge(encounterId);

      expect(await ch.next('stopped')).toMatchObject({ type: 'stopped', reason: 'ASSISTANT_ENCOUNTER_CLOSED' }); // prettier-ignore
      expect(await ch.closing).toBe(4409);
      const session = await prisma.listeningSession.findUnique({ where: { encounterId } }); // prettier-ignore
      expect(session?.state).toBe('STOPPED');
      // What was said before the discharge was kept, and nothing after it.
      const kept = await prisma.transcriptSegment.findMany({ where: { encounterId } }); // prettier-ignore
      expect(kept.map((s) => s.startMs)).toEqual([0]);
    });
  });

  describe('sin pérdida ni duplicados (AS-049 a AS-053)', () => {
    it('AS-051 AS-052 E-031: a pause, a cut mid-sentence, a reconnection that resends, and a stop — six segments in PostgreSQL, in order, none repeated', async () => {
      const lengthOf = (i: number) =>
        (SENTENCES[i + 1] ?? END_MS) - SENTENCES[i]!;
      const first = await listening();
      expect(first.offsetMs).toBe(0);

      first.speak(0, SENTENCES[2]!);
      first.send({ type: 'pause' });
      expect(await first.next('paused')).toEqual({
        type: 'paused',
        offsetMs: SENTENCES[2],
      });
      first.send({ type: 'start', device: 'computador' });
      await first.next('listening');
      first.speak(SENTENCES[2]!, lengthOf(2) + lengthOf(3));
      // The fourth sentence is inside the recogniser when the channel dies.
      await expect.poll(async () => (await prisma.listeningSession.findUnique({ where: { encounterId } }))?.offsetMs).toBeGreaterThanOrEqual(20_000); // prettier-ignore
      first.socket.terminate();
      await expect.poll(async () => (await prisma.listeningSession.findUnique({ where: { encounterId } }))?.state).toBe('PAUSED'); // prettier-ignore

      const second = await listening();
      expect(second.offsetMs).toBe(SENTENCES[4]);
      // The page resends its last second, which the server already has.
      second.speak(SENTENCES[4]! - 1_000, 1_000 + lengthOf(4) + lengthOf(5));
      second.send({ type: 'stop' });
      expect(await second.next('stopped')).toEqual({
        type: 'stopped',
        offsetMs: END_MS,
      });

      const kept = await prisma.transcriptSegment.findMany({ where: { encounterId }, orderBy: { startMs: 'asc' } }); // prettier-ignore
      expect(kept.map((s) => s.startMs)).toEqual(SENTENCES);
      expect(kept.at(-1)?.endMs).toBe(END_MS);
      expect(await prisma.listeningSession.findUnique({ where: { encounterId } })).toMatchObject({ state: 'STOPPED', offsetMs: END_MS, reason: null }); // prettier-ignore
    });

    it('AS-053 closes with 1009 a frame of more than one second', async () => {
      const ch = await listening();
      const big = Buffer.alloc(4 + 1_001 * BYTES_PER_MS, 1);

      ch.socket.send(big);

      expect(await ch.closing).toBe(1009);
    });

    it('AS-054 another channel of the same doctor takes the capture over', async () => {
      const desk = await listening();
      desk.speak(0, 500);
      const phone = await listening();

      expect(await desk.next('taken-over')).toEqual({ type: 'taken-over' });
      expect(phone.offsetMs).toBeGreaterThan(0);
    });
  });

  describe('la transcripción y su purga (AS-056, AS-057)', () => {
    it('AS-056 shows the listening and what it heard to its professional, and trails the read; not to another doctor', async () => {
      const ch = await listening();
      ch.speak(0, SENTENCES[1]!);
      ch.send({ type: 'stop' });
      await ch.next('stopped');

      const response = await request(app.getHttpServer()).get(url(encounterId)).set('Authorization', `Bearer ${doctor.token}`).expect(200); // prettier-ignore
      const body = response.body as { session: { state: string; capturing: boolean }; segments: { startMs: number; text: string }[] }; // prettier-ignore
      expect(body.session).toMatchObject({
        state: 'STOPPED',
        capturing: false,
      });
      expect(body.segments).toEqual([
        { startMs: 0, endMs: SENTENCES[1], text: 'Frase que empieza en 0.' },
      ]);
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'assistant_listening', resourceId: encounterId, action: 'READ' } }), // prettier-ignore
      ).toBe(1);

      await request(app.getHttpServer()).get(url(encounterId)).set('Authorization', `Bearer ${secondDoctor.token}`).expect(403); // prettier-ignore
    });

    it('AS-057 deletes 45 days after the first signature and 90 from each segment, and keeps what is younger', async () => {
      const day = 86_400_000;
      const now = new Date();
      const ago = (days: number) => new Date(now.getTime() - days * day);
      const signedLong = encounterId;
      const signedRecently = (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId })).id; // prettier-ignore
      const neverSigned = (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId })).id; // prettier-ignore
      for (const [id, signedAt] of [
        [signedLong, ago(46)],
        [signedRecently, ago(44)],
      ] as const) {
        const noteId = randomUUID();
        await prisma.clinicalNote.create({ data: { id: noteId, chainId: noteId, encounterId: id, formCode: '002', formVersion: '1', content: {}, authorId: doctor.practitionerId, status: 'SIGNED', signedById: doctor.practitionerId, contentHash: 'a'.repeat(64), signedAt } }); // prettier-ignore
      }
      const segment = (id: string, createdAt: Date, startMs = 0) => ({ encounterId: id, startMs, endMs: startMs + 1_000, text: 'Me duele la garganta.', createdAt }); // prettier-ignore
      await prisma.transcriptSegment.createMany({
        data: [
          segment(signedLong, ago(50)),
          segment(signedRecently, ago(50)),
          segment(neverSigned, ago(91)),
          segment(neverSigned, ago(89), 1_000),
        ],
      });

      const purged = await new PrismaListeningStore(prisma as never).purge(now);

      expect(purged).toBe(2);
      const left = await prisma.transcriptSegment.findMany({ select: { encounterId: true, startMs: true } }); // prettier-ignore
      expect(left).toEqual(
        expect.arrayContaining([
          { encounterId: signedRecently, startMs: 0 },
          { encounterId: neverSigned, startMs: 1_000 },
        ]),
      );
      expect(left).toHaveLength(2);
    });
  });
});
