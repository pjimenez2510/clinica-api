import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * E3: reprogramar, contra un PostgreSQL real.
 *
 * QUÉ SÓLO ESTA SUITE PUEDE DEMOSTRAR, y es la entrega entera:
 *
 *  - AG-050: que liberar el cupo original lo LIBERA de verdad — el mismo hueco
 *    vuelve a pasar por los tres `EXCLUDE USING gist` — y que la fila que ya
 *    existía conserva su intervalo.
 *  - AG-051: que las dos entradas se referencian, en la base y en la respuesta.
 *  - AG-052: que un destino ocupado deja el original OCUPANDO CALENDARIO. Eso
 *    no es «se lanzó un error»: es que la transacción se deshizo, y la única
 *    forma honesta de comprobarlo es volver a pedir el cupo original y que la
 *    base lo siga rechazando.
 *
 * LAS CITAS SON DEL PASADO A PROPÓSITO —lunes 5 de enero de 2026, como el
 * resto de las suites de agenda—, y la sede habilita AG-031 por eso mismo. La
 * ventana de reserva tiene sus propias pruebas en `agenda-parameters.spec.ts`.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';

/** 08:00–08:20 en Guayaquil del lunes 5 de enero de 2026. */
const ORIGINAL_SLOT = {
  startsAt: '2026-01-05T13:00:00Z',
  endsAt: '2026-01-05T13:20:00Z',
};

/** 09:00–09:20 el mismo día: borde de cupo de la misma regla. */
const NEW_SLOT = {
  startsAt: '2026-01-05T14:00:00Z',
  endsAt: '2026-01-05T14:20:00Z',
};

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface EntryBody {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  releasedAt: string | null;
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
}

interface RescheduledBody {
  original: EntryBody;
  created: EntryBody;
  warnings: string[];
}

describe('la reprogramación de una cita por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let userId: string;
  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let patientId: string;
  let otherPatientId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones, por lo mismo que en agenda-http.spec.ts:
        // se sustituye el ALMACÉN y no el guard, porque `APP_GUARD` cubre
        // también el de autorización, que aquí sí se comprueba.
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
    }

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const otherPatient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = practitioner.id;
    patientId = patient.id;
    otherPatientId = otherPatient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // Lunes, 08:00–12:00: cubre los dos huecos de arriba.
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );

    // AG-031: reservar en el pasado está cerrado de fábrica y todas las citas
    // de este fichero son del pasado, para que el reloj real no decida nada.
    await prisma.siteParameter.update({
      where: { siteId: site.id },
      data: { allowPastBooking: true },
    });

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        // Cédula sintética con dígito verificador calculado: nunca la de una
        // persona real.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    userId = user.id;

    const recepcion = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const book = (overrides: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId,
        practitionerId,
        bookingChannel: 'PHONE',
        ...ORIGINAL_SLOT,
        ...overrides,
      });

  async function bookedEntry(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await book(overrides).expect(201);
    return (response.body as EntryBody).id;
  }

  const reschedule = (
    entryId: string,
    body: Record<string, unknown> = {},
    site = siteId,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${site}/entries/${entryId}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...NEW_SLOT,
        bookingChannel: 'PHONE',
        reason: 'Paciente pide otra hora',
        ...body,
      });

  const historyOf = (entryId: string) =>
    prisma.agendaStatusHistory.findMany({
      where: { agendaEntryId: entryId },
      orderBy: { id: 'asc' },
    });

  describe('lo que ocurre cuando sale bien', () => {
    it('AG-050 libera el cupo original sin mover su intervalo, y el cupo se puede volver a reservar', async () => {
      const originalId = await bookedEntry();

      const response = await reschedule(originalId).expect(201);
      const body = response.body as RescheduledBody;

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      // Liberada, sí. MOVIDA, no: el intervalo de la fila que ya existía es
      // exactamente el que tenía. Si se hubiera hecho un UPDATE de `starts_at`
      // se habría borrado que esta cita fue a las 08:00 (§5).
      expect(stored.status).toBe('CANCELLED');
      expect(stored.releasedAt).toBeInstanceOf(Date);
      expect(stored.cancelledAt).toBeInstanceOf(Date);
      expect(stored.startsAt).toEqual(new Date(ORIGINAL_SLOT.startsAt));
      expect(stored.endsAt).toEqual(new Date(ORIGINAL_SLOT.endsAt));

      // Y la entrada NUEVA es otra fila, en el horario nuevo.
      expect(body.created.id).not.toBe(originalId);
      expect(new Date(body.created.startsAt)).toEqual(
        new Date(NEW_SLOT.startsAt),
      );
      expect(body.created.status).toBe('BOOKED');
      expect(body.created.releasedAt).toBeNull();

      // La prueba de que liberar libera DE VERDAD: el mismo cupo vuelve a
      // pasar por los tres `EXCLUDE USING gist`. Si `released_at` no fuera su
      // predicado, esto respondería 409.
      await book().expect(201);
    });

    it('AG-051 deja las dos entradas referenciándose, en la base y en la respuesta', async () => {
      const originalId = await bookedEntry();

      const response = await reschedule(originalId).expect(201);
      const body = response.body as RescheduledBody;

      // En la respuesta: ninguno de los dos lados obliga a una segunda
      // consulta para saber qué pasó con el otro.
      expect(body.original.id).toBe(originalId);
      expect(body.original.rescheduledToId).toBe(body.created.id);
      expect(body.created.rescheduledFromId).toBe(originalId);

      // Y en la base, que es donde la referencia tiene que ser RECORRIBLE: la
      // columna existe, la clave foránea la protege y el índice contesta el
      // sentido contrario sin recorrer la tabla.
      const created = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: body.created.id },
      });
      expect(created.rescheduledFromId).toBe(originalId);

      const successor = await prisma.agendaEntry.findFirstOrThrow({
        where: { rescheduledFromId: originalId },
      });
      expect(successor.id).toBe(body.created.id);

      // El listado del día las trae a las dos con su enlace (AG-018: las
      // liberadas hay que pedirlas).
      const day = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/entries`)
        .query({ date: '2026-01-05', includeReleased: 'true' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const items = (day.body as { items: EntryBody[] }).items;
      expect(
        items.find((item) => item.id === originalId)?.rescheduledToId,
      ).toBe(body.created.id);
      expect(
        items.find((item) => item.id === body.created.id)?.rescheduledFromId,
      ).toBe(originalId);
    });

    it('AG-004 escribe la transición de la original con su motivo y AG-005 no toca nada más', async () => {
      const originalId = await bookedEntry();

      const response = await reschedule(originalId, {
        reason: 'Paciente viaja esa mañana',
      }).expect(201);
      const created = (response.body as RescheduledBody).created;

      const rows = await historyOf(originalId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fromStatus: 'BOOKED',
        toStatus: 'CANCELLED',
        changedById: userId,
        note: 'Paciente viaja esa mañana',
      });
      // La entrada NUEVA nace, no transiciona: su historial está vacío igual
      // que el de cualquier cita recién reservada (AG-004 habla de
      // transiciones). Lo que la ata a la anterior es la columna, no una fila.
      await expect(historyOf(created.id)).resolves.toEqual([]);

      // Y el motivo también queda en la cita anulada, como en cualquier
      // anulación (AG-044).
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.cancellationNote).toBe('Paciente viaja esa mañana');
    });

    it('AG-050 la cita nueva hereda paciente, profesional y motivo, y registra quién la movió', async () => {
      const originalId = await bookedEntry({ reason: 'Control de presión' });

      const response = await reschedule(originalId, {
        bookingChannel: 'WALK_IN',
      }).expect(201);
      const created = (response.body as RescheduledBody).created;

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.patientId).toBe(patientId);
      expect(stored.practitionerId).toBe(practitionerId);
      // El motivo de consulta viaja con la cita: perderlo al reprogramar
      // vaciaría en silencio lo que recepción escribió.
      expect(stored.reason).toBe('Control de presión');
      // AG-029: el canal es el de AHORA, no el heredado — la métrica de
      // inasistencia agrupa por él.
      expect(stored.bookingChannel).toBe('WALK_IN');
      expect(stored.createdById).toBe(userId);
    });
  });

  describe('lo que ocurre cuando la cita nueva no puede crearse', () => {
    it('AG-052 con el cupo destino ocupado, el original SIGUE ocupando calendario', async () => {
      const originalId = await bookedEntry();
      // Otro paciente se queda con el destino: el que lo impide es
      // `agenda_entry_no_practitioner_overlap`, no una comprobación previa.
      await book({ patientId: otherPatientId, ...NEW_SLOT }).expect(201);

      const rejected = await reschedule(originalId).expect(409);
      expect((rejected.body as Problem).code).toBe('PRACTITIONER_SLOT_TAKEN');

      // LA AFIRMACIÓN QUE IMPORTA, y no es «se lanzó un error»: el original
      // sigue reservado, sin liberar y sin anular.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
      expect(stored.cancelledAt).toBeNull();
      expect(stored.cancellationNote).toBeNull();

      // Y OCUPA CALENDARIO, que es lo que «no liberar el cupo» significa: la
      // base sigue rechazando cualquier otra cita sobre ese hueco. Comprobar
      // sólo las columnas dejaría pasar una liberación parcial.
      const overlapping = await book({ patientId: otherPatientId }).expect(409);
      expect((overlapping.body as Problem).code).toBe(
        'PRACTITIONER_SLOT_TAKEN',
      );

      // Nada se escribió por el camino: ni historial ni entrada nueva.
      await expect(historyOf(originalId)).resolves.toEqual([]);
      await expect(
        prisma.agendaEntry.count({ where: { rescheduledFromId: originalId } }),
      ).resolves.toBe(0);
    });

    it('AG-052 con el paciente ya citado a esa hora, tampoco se libera nada', async () => {
      const originalId = await bookedEntry();
      // El mismo paciente, otro profesional del mismo horario: lo rechaza
      // `agenda_entry_no_patient_overlap` (AG-030), no el solape de agenda.
      const second = await createPractitioner(prisma);
      await linkPractitionerToSite(prisma, second.id, siteId);
      await createScheduleRule(
        prisma,
        { practitionerId: second.id, siteId },
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
      );
      await book({ practitionerId: second.id, ...NEW_SLOT }).expect(201);

      const rejected = await reschedule(originalId).expect(409);
      expect((rejected.body as Problem).code).toBe('PATIENT_DOUBLE_BOOKED');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
      await expect(historyOf(originalId)).resolves.toEqual([]);
    });

    it('AG-052 con un horario fuera de la agenda del profesional, el original queda intacto', async () => {
      const originalId = await bookedEntry();

      // 18:00 en Guayaquil: la regla acaba a las 12:00.
      const rejected = await reschedule(originalId, {
        startsAt: '2026-01-05T23:00:00Z',
        endsAt: '2026-01-05T23:20:00Z',
      }).expect(422);
      expect((rejected.body as Problem).code).toBe('OUTSIDE_SCHEDULE_RULE');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
      await expect(historyOf(originalId)).resolves.toEqual([]);
    });
  });

  describe('lo que se rechaza antes de tocar nada', () => {
    it('AG-044 exige el motivo de la reprogramación como error por campo', async () => {
      const originalId = await bookedEntry();

      const response = await reschedule(originalId, { reason: '' }).expect(422);
      const problem = response.body as Problem;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0]).toMatchObject({ field: 'reason' });

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-040 rechaza reprogramar una cita ya anulada, nombrando su estado', async () => {
      const originalId = await bookedEntry();
      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries/${originalId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'CANCELLED', reason: 'Paciente no puede' })
        .expect(200);

      const response = await reschedule(originalId).expect(409);
      expect((response.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      expect((response.body as Problem).title).toContain('Anulada');
    });

    it('AG-045 rechaza reprogramar una cita que ya tiene una atención registrada', async () => {
      const originalId = await bookedEntry();
      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries/${originalId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'CHECKED_IN' })
        .expect(200);
      await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: originalId,
      });

      const response = await reschedule(originalId).expect(409);
      expect((response.body as Problem).code).toBe(
        'AGENDA_ENTRY_HAS_ENCOUNTER',
      );

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: originalId },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-071 responde 404 para la cita de otra sede y 403 por la URL ajena', async () => {
      const foreign = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: otherSiteId,
          practitionerId,
          patientId,
          startsAt: ORIGINAL_SLOT.startsAt,
          endsAt: ORIGINAL_SLOT.endsAt,
          bookingChannel: 'PHONE',
          createdById: userId,
        },
      });

      const notFound = await reschedule(foreign.id).expect(404);
      expect((notFound.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');

      const denied = await reschedule(foreign.id, {}, otherSiteId).expect(403);
      expect((denied.body as Problem).code).toBe('SITE_SCOPE_DENIED');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: foreign.id },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-070 exige sesión para reprogramar', async () => {
      const originalId = await bookedEntry();

      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries/${originalId}/reschedule`)
        .send({ ...NEW_SLOT, bookingChannel: 'PHONE', reason: 'x' })
        .expect(401);
    });
  });
});
