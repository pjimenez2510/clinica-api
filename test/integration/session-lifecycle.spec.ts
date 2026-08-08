import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * The session, over real HTTP, against a real database.
 *
 * WHY THIS FILE EXISTS: every other test here talks to a service or to
 * PostgreSQL directly. Nothing exercised the assembled application, and the
 * gap had a precise cost — `POST /auth/refresh` answered with a token and no
 * identity. Every unit test passed, because none of them ever asked what the
 * endpoint actually returns. The browser found it: reloading the page produced
 * a valid session the client could not describe, so the dashboard drew itself
 * empty and the router, seeing a truthy user, never sent anybody to sign in.
 *
 * The rule it locks in: SIGNING IN AND RESUMING RETURN THE SAME THING. A
 * reload has to rebuild the whole session, and the only way it can is if
 * refresh says who you are, not just that you may continue.
 */
const PASSWORD = 'el caballo come alfalfa';

/**
 * The shape both `login` and `refresh` must answer with.
 *
 * Declared here rather than imported from the controller ON PURPOSE: this is
 * the contract as the CLIENT sees it. Importing the server's own type would
 * make the test agree with any change to it, including the one that removed
 * the identity from the refresh response.
 */
interface SessionBody {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; firstName: string; lastName: string };
  grants: { roleCode: string; siteId: string | null; permissions: string[] }[];
}

/** `response.body` is `any`; every read below goes through this instead. */
function sessionBody(response: request.Response): SessionBody {
  return response.body as SessionBody;
}

describe('session over HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Prisma hands back BigInt for bigserial ids and JSON.stringify throws on
    // them. `main.ts` calls this before creating the app; so must we, or the
    // first endpoint touching such a row fails for an unrelated reason.
    enableBigIntSerialisation();

    prisma = db();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The application must speak to the SAME database the fixtures write to.
      // Its own PrismaService points at the URL in the environment; overriding
      // it here is what keeps the two from being different databases.
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A signed-in-capable account holding a real role. */
  async function createAccount(): Promise<void> {
    await syncAuthorisation(prisma);

    const user = await prisma.user.create({
      data: {
        email: 'ana.torres@clinica.ec',
        firstName: 'Ana',
        lastName: 'Torres',
        // A real check digit: the database validates it and a made-up number
        // would fail for the wrong reason.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const medico = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: medico.id, siteId: null },
    });
  }

  it('answers a sign-in with the identity and the permissions', async () => {
    await createAccount();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    const body = sessionBody(response);
    expect(body.user).toMatchObject({
      email: 'ana.torres@clinica.ec',
      firstName: 'Ana',
      lastName: 'Torres',
    });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.grants.length).toBeGreaterThan(0);
    expect(body.grants[0]!.permissions.length).toBeGreaterThan(0);
  });

  it('answers a refresh with the identity too, not just a token', async () => {
    // THE REGRESSION. Refresh used to return `{ accessToken, expiresIn }`, and
    // a reload is the only path that depends on this response to learn who the
    // user is — the access token lives in memory and does not survive it.
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    const cookies = signedIn.get('Set-Cookie');
    expect(cookies, 'sign-in must set the refresh cookie').toBeDefined();

    const resumed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies!)
      .expect(200);

    const before = sessionBody(signedIn);
    const after = sessionBody(resumed);

    expect(after.user).toEqual(before.user);
    expect(after.grants).toEqual(before.grants);
    expect(after.expiresIn).toEqual(before.expiresIn);
    // A NEW token, because rotation is the point of the endpoint.
    expect(after.accessToken).not.toEqual(before.accessToken);
  });

  it('refuses to resume without the cookie', async () => {
    await createAccount();

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').expect(401);
  });

  it('never puts the refresh token in the response body', async () => {
    // It travels in an httpOnly cookie precisely so an injected script cannot
    // read it. Leaking it in the body would undo that in one line.
    await createAccount();

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    expect(Object.keys(sessionBody(signedIn))).not.toContain('refreshToken');

    const resumed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', signedIn.get('Set-Cookie')!)
      .expect(200);

    expect(Object.keys(sessionBody(resumed))).not.toContain('refreshToken');
  });
});
