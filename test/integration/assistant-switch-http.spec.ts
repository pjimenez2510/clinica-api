import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
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

  it('AS-026 answers 404 without a session, with a malformed id and to a body that does not validate', async () => {
    const server = app.getHttpServer();
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/assistant/diagnoses`).expect(404); // prettier-ignore
    await request(server).post('/api/v1/encounters/no-es-un-uuid/assistant/diagnoses/read').expect(404); // prettier-ignore
    await request(server)
      .post(
        `/api/v1/encounters/${ENCOUNTER}/assistant/diagnoses/${ENCOUNTER}/accept`,
      ) // prettier-ignore
      .send({})
      .expect(404);
    // Control: a route of the same API, outside the assistant, still asks for a session.
    await request(server).get(`/api/v1/encounters/${ENCOUNTER}/diagnoses`).expect(401); // prettier-ignore
  });
});
