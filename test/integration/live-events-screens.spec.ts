import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
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

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import {
  ofKind,
  type OpenStream,
  openLiveStream,
  until,
} from './setup/live-stream';

/**
 * The screens' live events over HTTP (D-187, paso 2): who opens the channel
 * now that it is not only the doctor's, and what each real session hears
 * when the agenda or caja of a site changes through the API (AU-054 afinado,
 * AG-179, AG-180, BI-238).
 *
 * EVERY «does not arrive» HAS ITS POSITIVE CONTROL on the same path: the
 * stream that must not hear site A hears site B's own write, and the waiting
 * room that must not hear `agenda` hears `waiting-room` of the same write.
 */
const PASSWORD = 'el caballo come alfalfa';
const HEARTBEAT_MS = 150;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

describe('los avisos en vivo de agenda, tableros, sala y caja por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let baseUrl: string;
  const opened: OpenStream[] = [];

  let siteA: string;
  let siteB: string;
  let practitionerId: string;
  let payerId: string;
  let booked = 0;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
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

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();
    siteA = (await createSite(prisma, 'Sede Norte')).id;
    siteB = (await createSite(prisma, 'Sede Sur')).id;
    practitionerId = (await createPractitioner(prisma)).id;
    await linkPractitionerToSite(prisma, practitionerId, siteA);
    await linkPractitionerToSite(prisma, practitionerId, siteB);
    payerId = (
      await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })
    ).id;
  });

  afterEach(() => {
    for (const stream of opened.splice(0)) stream.close();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function account(
    email: string,
    roleCode: string,
    siteId: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
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
    return (login.body as { accessToken: string }).accessToken;
  }

  async function openStream(token: string): Promise<OpenStream> {
    const stream = await openLiveStream(baseUrl, token);
    opened.push(stream);
    expect(stream.status).toBe(200);
    await until(() => stream.events.length > 0);
    return stream;
  }

  /** A booked appointment two days from now, written straight to the table. */
  async function appointment(siteId: string): Promise<string> {
    const patient = await createPatient(prisma);
    // One hour apart: the same practitioner cannot be booked twice at once.
    booked += 1;
    const startsAt = new Date(Date.now() + 2 * DAY_MS + booked * 60 * MINUTE_MS); // prettier-ignore
    const entry = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId,
        practitionerId,
        patientId: patient.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 20 * MINUTE_MS),
        status: 'BOOKED',
        bookingChannel: 'PHONE',
      },
    });
    return entry.id;
  }

  const cancel = (token: string, siteId: string, entryId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ to: 'CANCELLED', reason: 'El paciente no puede venir' });

  /** Two heartbeats more: whatever the write published has had its chance. */
  async function settled(stream: OpenStream): Promise<void> {
    const beats = ofKind(stream, 'heartbeat').length;
    await until(() => ofKind(stream, 'heartbeat').length >= beats + 2);
  }

  const kindsOf = (stream: OpenStream) =>
    stream.events
      .map((event) => event.type)
      .filter((type) => !['ready', 'heartbeat', 'resync'].includes(type));

  it('AU-054 (afinado): recepción, caja y la pantalla de sala abren el canal sin `record:read`', async () => {
    for (const [email, role] of [
      ['recepcion@clinica.ec', 'RECEPCION'],
      ['caja@clinica.ec', 'CAJA'],
      ['sala@clinica.ec', 'PANTALLA_SALA'],
    ] as const) {
      const stream = await openStream(await account(email, role, siteA));
      expect(stream.events[0]?.type).toBe('ready');
    }
  });

  it('AG-179, AG-180: anular una cita de A llega a recepción de A y a la sala de A, con su tipo y su sede, y no a recepción de B', async () => {
    const receptionA = await account('recepcion.norte@clinica.ec', 'RECEPCION', siteA); // prettier-ignore
    const receptionB = await account('recepcion.sur@clinica.ec', 'RECEPCION', siteB); // prettier-ignore
    const roomA = await account(
      'sala.norte@clinica.ec',
      'PANTALLA_SALA',
      siteA,
    );
    const entryA = await appointment(siteA);
    const entryB = await appointment(siteB);
    const streamA = await openStream(receptionA);
    const streamB = await openStream(receptionB);
    const room = await openStream(roomA);

    await cancel(receptionA, siteA, entryA).expect(200);

    await until(() => ofKind(streamA, 'agenda').length === 1);
    await until(() => ofKind(room, 'waiting-room').length === 1);
    expect(JSON.parse(ofKind(streamA, 'agenda')[0]!.data)).toEqual({
      kind: 'agenda',
      siteId: siteA,
    });
    expect(JSON.parse(ofKind(room, 'waiting-room')[0]!.data)).toEqual({
      kind: 'waiting-room',
      siteId: siteA,
    });

    // Control positivo: B hears its own site's write, and only that one.
    await cancel(receptionB, siteB, entryB).expect(200);
    await until(() => ofKind(streamB, 'agenda').length === 1);
    expect(JSON.parse(ofKind(streamB, 'agenda')[0]!.data)).toEqual({
      kind: 'agenda',
      siteId: siteB,
    });
    await settled(streamA);
    expect(ofKind(streamA, 'agenda')).toHaveLength(1);

    // AG-180. The room hears what it projects and nothing else.
    await settled(room);
    expect(kindsOf(room)).toEqual(['waiting-room']);
  });

  it('AG-179: una escritura rechazada no avisa a nadie (control: la misma ruta aceptada sí)', async () => {
    const receptionA = await account('recepcion.norte@clinica.ec', 'RECEPCION', siteA); // prettier-ignore
    const entryA = await appointment(siteA);
    const stream = await openStream(receptionA);

    await cancel(receptionA, siteA, entryA).expect(200);
    await until(() => ofKind(stream, 'agenda').length === 1);

    // Cancelling it again is refused: nothing changed, nothing is said.
    const refused = await cancel(receptionA, siteA, entryA);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await settled(stream);
    expect(ofKind(stream, 'agenda')).toHaveLength(1);
  });

  it('AG-179: la nota del tablero llega a recepción como `agenda` y no despierta a la sala', async () => {
    const nurseA = await account('enfermeria.norte@clinica.ec', 'ENFERMERIA', siteA); // prettier-ignore
    const roomA = await account(
      'sala.norte@clinica.ec',
      'PANTALLA_SALA',
      siteA,
    );
    const entryA = await appointment(siteA);
    const staff = await openStream(nurseA);
    const room = await openStream(roomA);

    await request(app.getHttpServer())
      .put(`/api/v1/agenda/sites/${siteA}/entries/${entryA}/board-note`)
      .set('Authorization', `Bearer ${nurseA}`)
      .send({ boardNote: 'Pasa a curación' })
      .expect(200);

    await until(() => ofKind(staff, 'agenda').length === 1);
    await settled(room);
    expect(kindsOf(room)).toEqual([]);
  });

  it('BI-238: abrir una cuenta en A llega a caja de A como `billing`, no a caja de B ni a recepción de A', async () => {
    const cashierA = await account('caja.norte@clinica.ec', 'CAJA', siteA);
    const cashierB = await account('caja.sur@clinica.ec', 'CAJA', siteB);
    const receptionA = await account('recepcion.norte@clinica.ec', 'RECEPCION', siteA); // prettier-ignore
    const streamA = await openStream(cashierA);
    const streamB = await openStream(cashierB);
    const reception = await openStream(receptionA);

    const openAccount = (token: string, siteId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/billing/sites/${siteId}/accounts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ patientId: patientIds.shift(), payerId })
        .expect(201);
    const patientIds = [
      (await createPatient(prisma)).id,
      (await createPatient(prisma)).id,
    ];

    await openAccount(cashierA, siteA);
    await until(() => ofKind(streamA, 'billing').length === 1);
    expect(JSON.parse(ofKind(streamA, 'billing')[0]!.data)).toEqual({
      kind: 'billing',
      siteId: siteA,
    });

    // Control positivo en B.
    await openAccount(cashierB, siteB);
    await until(() => ofKind(streamB, 'billing').length === 1);
    expect(JSON.parse(ofKind(streamB, 'billing')[0]!.data)).toEqual({
      kind: 'billing',
      siteId: siteB,
    });
    await settled(streamA);
    expect(ofKind(streamA, 'billing')).toHaveLength(1);
    // Reception of A reads no caja: it is told nothing about it.
    await settled(reception);
    expect(kindsOf(reception)).toEqual([]);
  });
});
