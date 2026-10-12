import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import type { LiveEvent } from '../../src/shared/events/live-event';
import {
  InProcessLiveEventBus,
  LiveEventBus,
} from '../../src/shared/events/live-event-bus';
import { LIVE_HEARTBEAT } from '../../src/shared/events/live-event-stream';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import {
  ofKind,
  type OpenStream,
  openLiveStream,
  until,
} from './setup/live-stream';

/**
 * AU-060 over HTTP: the assistant's two notices reach, through the real
 * stream and its real guards, only the addressed sessions that hold
 * `record:write` at the notice's site.
 *
 * Nobody publishes them yet (the assistant arrives later), so the test
 * publishes on the application's own bus, which is exactly what a worker
 * will do. Each refusal is read after a barrier: an `agenda` notice every
 * stream does hear, published after the assistant's, so «not received» means
 * «filtered», not «not arrived yet».
 */
const PASSWORD = 'el caballo come alfalfa';
const HEARTBEAT_MS = 150;

describe('los avisos del asistente por el canal en vivo', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let bus: LiveEventBus;
  let baseUrl: string;
  const opened: OpenStream[] = [];

  let siteA: string;
  let siteB: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      bus = new InProcessLiveEventBus();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(LiveEventBus)
        .useValue(bus)
        .overrideProvider(LIVE_HEARTBEAT)
        .useValue(HEARTBEAT_MS)
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
      const { port } = app.getHttpServer().address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}/api/v1`;
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteA = (await createSite(prisma, 'Sede Norte')).id;
    siteB = (await createSite(prisma, 'Sede Sur')).id;
  });

  afterEach(() => {
    for (const stream of opened.splice(0)) stream.close();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function session(
    email: string,
    roleCode: string,
    siteId: string,
  ): Promise<{ userId: string; stream: OpenStream }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
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
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const stream = await openLiveStream(
      baseUrl,
      (login.body as { accessToken: string }).accessToken,
    );
    opened.push(stream);
    expect(stream.status).toBe(200);
    await until(() => ofKind(stream, 'ready').length === 1);
    return { userId: user.id, stream };
  }

  it('AU-060: «borrador listo» llega al médico que lo pidió, con su tipo y su sede, y no al colega, ni a enfermería sin `record:write`, ni a otra sede', async () => {
    const doctor = await session('medico.norte@clinica.ec', 'MEDICO', siteA);
    const colleague = await session('colega.norte@clinica.ec', 'MEDICO', siteA); // prettier-ignore
    const nurse = await session('enfermeria.norte@clinica.ec', 'ENFERMERIA', siteA); // prettier-ignore
    const south = await session('medico.sur@clinica.ec', 'MEDICO', siteB);

    bus.publish({
      kind: 'assistant-draft',
      siteId: siteA,
      userIds: [doctor.userId, nurse.userId, south.userId],
    });
    bus.publish({ kind: 'agenda', siteId: siteA });
    bus.publish({ kind: 'agenda', siteId: siteB });

    await until(() => ofKind(doctor.stream, 'assistant-draft').length === 1);
    // AU-055: what reaches the browser is rebuilt as kind and site, without
    // the addressees.
    expect(JSON.parse(ofKind(doctor.stream, 'assistant-draft')[0]!.data)).toEqual({ kind: 'assistant-draft', siteId: siteA }); // prettier-ignore
    for (const other of [colleague, nurse, south]) {
      await until(() => ofKind(other.stream, 'agenda').length === 1);
      expect(ofKind(other.stream, 'assistant-draft')).toHaveLength(0);
    }
  });

  it('AU-060: «propuesta lista» sin destinatarios no llega a nadie; con ellos, sí', async () => {
    const doctor = await session('medico.norte@clinica.ec', 'MEDICO', siteA);

    // The type refuses it; a bug or a forged message is what could send it.
    bus.publish({ kind: 'assistant-proposal', siteId: siteA } as LiveEvent);
    bus.publish({ kind: 'agenda', siteId: siteA });
    await until(() => ofKind(doctor.stream, 'agenda').length === 1);
    expect(ofKind(doctor.stream, 'assistant-proposal')).toHaveLength(0);

    // Control positivo: the same notice, addressed, on the same stream.
    bus.publish({
      kind: 'assistant-proposal',
      siteId: siteA,
      userIds: [doctor.userId],
    });
    await until(() => ofKind(doctor.stream, 'assistant-proposal').length === 1);
  });
});
