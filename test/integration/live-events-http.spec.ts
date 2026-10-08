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
import {
  InProcessLiveEventBus,
  LiveEventBus,
} from '../../src/shared/events/live-event-bus';
import { LIVE_HEARTBEAT } from '../../src/shared/events/live-event-stream';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aTariffConcept, seedExams } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createEncounter, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import {
  ofKind,
  type OpenStream,
  openLiveStream,
  until,
} from './setup/live-stream';

/**
 * The live-events channel over HTTP, with real sessions against a real
 * PostgreSQL (AU-054 to AU-057, ORD-164).
 *
 * What only this level shows: that the ordinary guards decide who opens the
 * stream, that a critical value written through the API reaches the stream of
 * a session that reads ITS site and not the stream of one that reads another
 * — the positive control and the refusal on the same path —, and that closing
 * the session closes the stream.
 *
 * In-process bus: what crosses Redis is `live-events-redis.spec.ts`.
 */
const PASSWORD = 'el caballo come alfalfa';
const HEARTBEAT_MS = 150;

describe('el canal de avisos en vivo por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let baseUrl: string;
  const opened: OpenStream[] = [];

  let siteA: string;
  let siteB: string;
  let orderA: string;
  let orderB: string;
  let glucoseAnalyteId: string;
  let glucoseExamId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // The developer's `.env` may name a Redis; this suite is about the
        // guards and the scope, not the broker.
        .overrideProvider(LiveEventBus)
        .useValue(new InProcessLiveEventBus())
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

    await seed();
  });

  afterEach(() => {
    for (const stream of opened.splice(0)) stream.close();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await syncAuthorisation(prisma);
    registry.invalidate();
    siteA = (await createSite(prisma, 'Sede Norte')).id;
    siteB = (await createSite(prisma, 'Sede Sur')).id;
    const exams = await seedExams(prisma);
    await aTariffConcept(prisma, { code: 'EX-GLUCOSA-AYUNAS' });
    glucoseAnalyteId = exams.glu.id;
    glucoseExamId = exams.glucose.id;
  }

  async function account(
    email: string,
    roleCode: string,
    siteId: string,
  ): Promise<{ token: string; userId: string; practitionerId: string }> {
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
    const practitioner = await prisma.practitioner.create({
      data: { userId: user.id },
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
    return {
      token: (login.body as { accessToken: string }).accessToken,
      userId: user.id,
      practitionerId: practitioner.id,
    };
  }

  /** An issued glucose order at the site, ready to receive a result. */
  async function issuedOrder(
    token: string,
    siteId: string,
    practitionerId: string,
  ): Promise<string> {
    const patient = await createPatient(prisma);
    const encounter = await createEncounter(prisma, {
      siteId,
      practitionerId,
      patientId: patient.id,
    });
    const order = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounter.id}/orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        category: 'LABORATORY',
        items: [{ examDefinitionId: glucoseExamId }],
      })
      .expect(201);
    const id = (order.body as { id: string }).id;
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${id}/issue`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    return id;
  }

  async function criticalGlucose(
    token: string,
    orderId: string,
  ): Promise<string> {
    const report = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/reports`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
        results: [{ analyteDefinitionId: glucoseAnalyteId, valueNumeric: 25 }],
      })
      .expect(201);
    return (report.body as { results: { id: string }[] }).results[0]!.id;
  }

  /** Opens `GET /events` with `fetch`, the way the interface does. */
  async function openStream(token?: string): Promise<OpenStream> {
    const stream = await openLiveStream(baseUrl, token);
    opened.push(stream);
    return stream;
  }

  it('AU-054: sin sesión no hay canal, y sin el permiso de ningún tipo de aviso tampoco; con él, abre y late', async () => {
    const anonymous = await openStream();
    expect(anonymous.status).toBe(401);

    // AU-054 afinado: the auditor reads the access log and nothing a live
    // screen shows.
    const auditor = await account('auditoria@clinica.ec', 'AUDITOR', siteA);
    const refused = await fetch(`${baseUrl}/events`, {
      headers: { Authorization: `Bearer ${auditor.token}` },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'PERMISSION_DENIED',
    );

    // Control positivo: el mismo camino, con una sesión que lee una sede.
    const doctor = await account('medico.norte@clinica.ec', 'MEDICO', siteA);
    const stream = await openStream(doctor.token);
    expect(stream.status).toBe(200);
    await until(() => ofKind(stream, 'heartbeat').length >= 2);
    expect(stream.events[0]?.type).toBe('ready');
  });

  it('AU-055, AU-056, ORD-164: el crítico de la sede A llega a quien lee A, con su tipo y su sede y nada más, y no a quien lee sólo B', async () => {
    const north = await account('medico.norte@clinica.ec', 'MEDICO', siteA);
    const south = await account('medico.sur@clinica.ec', 'MEDICO', siteB);
    orderA = await issuedOrder(north.token, siteA, north.practitionerId);
    orderB = await issuedOrder(south.token, siteB, south.practitionerId);
    const northStream = await openStream(north.token);
    const southStream = await openStream(south.token);
    await until(() => northStream.events.length > 0 && southStream.events.length > 0); // prettier-ignore

    await criticalGlucose(north.token, orderA);

    await until(() => ofKind(northStream, 'critical-results').length === 1);
    expect(
      JSON.parse(ofKind(northStream, 'critical-results')[0]!.data),
    ).toEqual({
      kind: 'critical-results',
      siteId: siteA,
    });

    // The south stream had the time to hear it: it hears its own site's next.
    await criticalGlucose(south.token, orderB);
    await until(() => ofKind(southStream, 'critical-results').length === 1);
    expect(
      ofKind(southStream, 'critical-results').map((event) => JSON.parse(event.data) as unknown), // prettier-ignore
    ).toEqual([{ kind: 'critical-results', siteId: siteB }]);
    expect(ofKind(northStream, 'critical-results')).toHaveLength(1);
  });

  it('ORD-164: registrar el aviso de un crítico también avisa a su sede', async () => {
    const north = await account('medico.norte@clinica.ec', 'MEDICO', siteA);
    orderA = await issuedOrder(north.token, siteA, north.practitionerId);
    const resultId = await criticalGlucose(north.token, orderA);
    const stream = await openStream(north.token);
    await until(() => stream.events.length > 0);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/results/${resultId}/notices`)
      .set('Authorization', `Bearer ${north.token}`)
      .send({
        outcome: 'NOTIFIED',
        readBack: true,
        recipientKind: 'PATIENT',
        recipientName: 'La paciente',
        channel: 'PHONE',
      })
      .expect(201);

    await until(() => ofKind(stream, 'critical-results').length === 1);
  });

  it('AU-057: cerrar la sesión corta el canal en el latido siguiente', async () => {
    const north = await account('medico.norte@clinica.ec', 'MEDICO', siteA);
    const stream = await openStream(north.token);
    await until(() => ofKind(stream, 'heartbeat').length >= 1);
    let ended = false;
    void stream.ended.then(() => {
      ended = true;
    });

    // Control positivo: abierto, sigue latiendo.
    await until(() => ofKind(stream, 'heartbeat').length >= 2);
    expect(ended).toBe(false);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${north.token}`)
      .expect(204);

    await until(() => ended);
    // And reopening with the same token is refused by the ordinary guard.
    expect((await openStream(north.token)).status).toBe(401);
  });

  it('AU-056: quitarle al rol todo permiso de aviso a mitad del flujo lo corta en el latido siguiente', async () => {
    // AU-054 afinado: the stream lives while the session holds the permission
    // of SOME kind; ENFERMERIA holds two (`record:read`, `agenda:read`).
    const north = await account('enfermeria.norte@clinica.ec', 'ENFERMERIA', siteA); // prettier-ignore
    const stream = await openStream(north.token);
    let ended = false;
    void stream.ended.then(() => {
      ended = true;
    });
    // Control positivo: con el permiso, sigue latiendo.
    await until(() => ofKind(stream, 'heartbeat').length >= 2);
    expect(ended).toBe(false);

    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'ENFERMERIA' } }); // prettier-ignore
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionCode: 'record:read' },
    });
    registry.invalidate();
    // With `agenda:read` left, it is still open: it hears the agenda.
    const beats = ofKind(stream, 'heartbeat').length;
    await until(() => ofKind(stream, 'heartbeat').length >= beats + 2);
    expect(ended).toBe(false);

    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionCode: 'agenda:read' },
    });
    registry.invalidate();

    await until(() => ended);
  });
});
