import type { AddressInfo } from 'node:net';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { LISTENING_PATH } from '../../src/modules/assistant/infrastructure/listening.gateway';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-026 by HTTP: with `ASSISTANT_ENABLED` off, every assistant route answers
 * the 404 of a route that does not exist — before the session, the
 * permission and the pipes. The positive control (on → 401 without session)
 * is in `assistant-diagnosis-http.spec.ts`.
 */
describe('el asistente apagado (AS-026)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;

  beforeAll(async () => {
    enableBigIntSerialisation();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db())
      .overrideProvider(ASSISTANT_ENABLED)
      .useValue(false)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }); // prettier-ignore
    configureApp(app);
    await listenForTests(app);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  const ENCOUNTER = '0190a2b4-0000-7000-8000-000000000001';

  it('AS-026 AS-086 answers 404 without a session, with a malformed id and to a body that does not validate', async () => {
    const server = app.getHttpServer();
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/diagnoses`).expect(404); // prettier-ignore
    await request(server).post('/api/v1/encounters/no-es-un-uuid/assistant/diagnoses/read').expect(404); // prettier-ignore
    await request(server)
      .post(
        `/api/v1/encounters/${ENCOUNTER}/assistant/diagnoses/${ENCOUNTER}/accept`,
      ) // prettier-ignore
      .send({})
      .expect(404);
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/listening`).expect(404); // prettier-ignore
    await request(server).post(`/api/v1/encounters/${ENCOUNTER}/assistant/listening/ticket`).expect(404); // prettier-ignore
    // AS-086, AS-094, AS-096. The draft of the note, the same.
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/note-draft`).expect(404); // prettier-ignore
    await request(server).post(`/api/v1/encounters/${ENCOUNTER}/assistant/note-draft`).expect(404); // prettier-ignore
    await request(server).post(`/api/v1/encounters/${ENCOUNTER}/assistant/note-draft/sections/${ENCOUNTER}/accept`).send({}).expect(404); // prettier-ignore
    // Control: a route of the same API, outside the assistant, still asks for a session.
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/diagnoses`).expect(401); // prettier-ignore
  });

  it('AS-046 answers 404 to opening the audio channel', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${LISTENING_PATH}`);

    await expect(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
    ).rejects.toThrow(/404/);
  });

  it('AS-026 AS-111 answers 404 to the exams the assistant proposes, before any session', async () => {
    const server = app.getHttpServer();
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/orders`).expect(404); // prettier-ignore
    await request(server).post(`/api/v1/encounters/${ENCOUNTER}/assistant/orders/read`).expect(404); // prettier-ignore
    await request(server).post(`/api/v1/encounters/${ENCOUNTER}/assistant/orders/link`).send({}).expect(404); // prettier-ignore
    // Control: the orders of the attention, outside the assistant, ask for a session.
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/orders`).expect(401); // prettier-ignore
  });

  it('AS-026 AS-185 answers 404 to the dictated vital signs, before the session and the recording', async () => {
    const server = app.getHttpServer();
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/vitals-dictation`).expect(404); // prettier-ignore
    await request(server)
      .post(`/api/v1/encounters/${ENCOUNTER}/assistant/vitals-dictation`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('RIFF invented'))
      .expect(404);
    // Control: the taking itself, outside the assistant, asks for a session.
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/vitals`).expect(401); // prettier-ignore
  });
});
