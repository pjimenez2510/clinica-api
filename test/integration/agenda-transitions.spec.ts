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
 * E2: the day of the consultation, against a real PostgreSQL.
 *
 * WHAT ONLY THIS SUITE CAN PROVE: that a transition and its history row are
 * ONE transaction, that `released_at` really releases the `EXCLUDE`
 * constraints — the same slot books again — and that two receptionists
 * resolving the same appointment produce exactly one winner. Doubles can
 * assert none of that.
 *
 * THE APPOINTMENTS ARE IN THE PAST ON PURPOSE — Monday 5 January 2026, under
 * the same rule as the rest of the agenda suites — because AG-042 and AG-044
 * exercise transitions the real clock must allow: a NO_SHOW needs `now` past
 * the start. The one FUTURE appointment (AG-043) is created relative to the
 * clock, a year ahead, so the refusal it asserts never expires with the
 * calendar.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';

/** 08:00–08:20 in Guayaquil on Monday 5 January 2026: long past already. */
const PAST_SLOT = {
  startsAt: '2026-01-05T13:00:00Z',
  endsAt: '2026-01-05T13:20:00Z',
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
  releasedAt: string | null;
}

describe('las transiciones de estado de la cita por HTTP', () => {
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

    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = practitioner.id;
    patientId = patient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // Lunes, 08:00–12:00, cupos de veinte minutos, vigente desde 2026-01-01:
    // cubre el lunes 5 de enero en el que viven estas citas.
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );

    // AG-031, desde E7: reservar con inicio anterior a ahora está cerrado de
    // fábrica, y todas las citas de este fichero son del pasado a propósito
    // (una inasistencia necesita que la hora de inicio ya haya pasado). La
    // sede habilita el registro a posteriori, que es exactamente el caso para
    // el que existe el parámetro; el interruptor en sí lo prueban AG-031 y
    // AG-094 en `agenda-parameters.spec.ts`.
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
    // EN UNA SEDE, no en todas: es lo que hace comprobable el 404 de la sede
    // ajena frente al 403 del guard.
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
        ...PAST_SLOT,
        ...overrides,
      });

  /** Reserva y devuelve el identificador de la cita, ya en BOOKED. */
  async function bookedEntry(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await book(overrides).expect(201);
    return (response.body as EntryBody).id;
  }

  const transition = (
    entryId: string,
    body: Record<string, unknown>,
    site = siteId,
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${site}/entries/${entryId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** AG-037. Cierra un intervalo de la agenda del profesional. */
  const block = (overrides: Record<string, unknown> = {}, site = siteId) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${site}/blocks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ practitionerId, ...PAST_SLOT, ...overrides });

  /** AG-114. Deshace un bloqueo: libera el intervalo y NO borra la fila. */
  const releaseBlock = (entryId: string, site = siteId) =>
    request(app.getHttpServer())
      .delete(`/api/v1/agenda/sites/${site}/blocks/${entryId}`)
      .set('Authorization', `Bearer ${token}`);

  const historyOf = (entryId: string) =>
    prisma.agendaStatusHistory.findMany({
      where: { agendaEntryId: entryId },
      orderBy: { id: 'asc' },
    });

  describe('el historial de transiciones', () => {
    it('AG-004 deja una fila por transición con estados, autor y AG-005 nunca toca la anterior', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'CONFIRMED' }).expect(200);
      const afterFirst = await historyOf(entryId);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]).toMatchObject({
        fromStatus: 'BOOKED',
        toStatus: 'CONFIRMED',
        changedById: userId,
        note: null,
      });
      expect(afterFirst[0]?.changedAt).toBeInstanceOf(Date);

      await transition(entryId, { to: 'CHECKED_IN' }).expect(200);
      const afterSecond = await historyOf(entryId);
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[1]).toMatchObject({
        fromStatus: 'CONFIRMED',
        toStatus: 'CHECKED_IN',
        changedById: userId,
      });
      // AG-005: la segunda transición no reescribió la primera fila. Se
      // compara la fila entera: append-only significa intacta, no «parecida».
      expect(afterSecond[0]).toEqual(afterFirst[0]);
    });

    it('AG-004 guarda el motivo en la nota del historial cuando viene', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, {
        to: 'CANCELLED',
        reason: 'Paciente reagenda por viaje',
      }).expect(200);

      const rows = await historyOf(entryId);
      expect(rows[0]?.note).toBe('Paciente reagenda por viaje');
    });
  });

  describe('los efectos de cada estado', () => {
    it('AG-041 fija checked_in_at al registrar la llegada', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, { to: 'CHECKED_IN' }).expect(
        200,
      );

      expect((response.body as EntryBody).status).toBe('CHECKED_IN');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.checkedInAt).toBeInstanceOf(Date);
      // Llegar ocupa el cupo, no lo libera.
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-042 fija no_show_at, libera el cupo y el mismo cupo se puede volver a reservar', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'NO_SHOW' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('NO_SHOW');
      expect(stored.noShowAt).toBeInstanceOf(Date);
      expect(stored.releasedAt).toBeInstanceOf(Date);

      // La prueba de que liberar libera DE VERDAD: el mismo paciente, el
      // mismo profesional y el mismo horario pasan otra vez por los tres
      // `EXCLUDE USING gist`. Si `released_at` no fuera su predicado, esto
      // respondería 409.
      await book().expect(201);
    });

    it('AG-044 exige motivo al anular como error por campo', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, { to: 'CANCELLED' }).expect(
        422,
      );

      const problem = response.body as Problem;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0]).toMatchObject({
        field: 'reason',
        message: 'Indique el motivo de la anulación',
      });
      // Y nada cambió: ni estado ni historial.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('BOOKED');
      await expect(historyOf(entryId)).resolves.toEqual([]);
    });

    it('AG-044 con motivo fija cancelled_at, libera el cupo y guarda la nota', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, {
        to: 'CANCELLED',
        reason: 'Paciente reagenda',
      }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.cancelledAt).toBeInstanceOf(Date);
      expect(stored.releasedAt).toBeInstanceOf(Date);
      expect(stored.cancellationNote).toBe('Paciente reagenda');

      const rows = await historyOf(entryId);
      expect(rows[0]).toMatchObject({
        fromStatus: 'BOOKED',
        toStatus: 'CANCELLED',
        note: 'Paciente reagenda',
      });
    });
  });

  describe('lo que se rechaza', () => {
    it('AG-040 responde 409 INVALID_AGENDA_TRANSITION nombrando el estado actual en español', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, { to: 'FULFILLED' }).expect(
        409,
      );

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_AGENDA_TRANSITION');
      expect(problem.title).toBe(
        'La cita está en estado «Agendada» y no admite ese cambio. Actualice la agenda',
      );
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      // Nada se escribió por el camino: la transición rechazada no deja fila.
      await expect(historyOf(entryId)).resolves.toEqual([]);
    });

    it('AG-043 rechaza NO_SHOW sobre una cita que aún no empieza', async () => {
      // La cita futura se crea RELATIVA AL RELOJ, un año adelante, para que
      // esta prueba no caduque con el calendario. Se inserta directo: la
      // política de reserva no es lo que se prueba aquí.
      const inAYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const future = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId,
          practitionerId,
          patientId,
          startsAt: inAYear,
          endsAt: new Date(inAYear.getTime() + 20 * 60 * 1000),
          bookingChannel: 'PHONE',
          createdById: userId,
        },
      });

      const response = await transition(future.id, { to: 'NO_SHOW' }).expect(
        422,
      );

      expect((response.body as Problem).code).toBe('NO_SHOW_BEFORE_START');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: future.id },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-045 rechaza anular o marcar inasistencia cuando ya hay una atención registrada', async () => {
      // El encuentro se cuelga de una cita en CHECKED_IN a propósito:
      // IN_PROGRESS → CANCELLED ni siquiera está en la tabla, y esta prueba
      // debe aislar el veto de AG-045 del rechazo de tabla de AG-040.
      const checkedIn = await bookedEntry();
      await transition(checkedIn, { to: 'CHECKED_IN' }).expect(200);
      await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: checkedIn,
      });

      const cancelled = await transition(checkedIn, {
        to: 'CANCELLED',
        reason: 'x',
      }).expect(409);
      expect((cancelled.body as Problem).code).toBe(
        'AGENDA_ENTRY_HAS_ENCOUNTER',
      );
      expect((cancelled.body as Problem).title).toBe(
        'La cita ya tiene una atención registrada: no puede anularse ni marcarse como inasistencia',
      );

      const noShow = await transition(checkedIn, { to: 'NO_SHOW' }).expect(409);
      expect((noShow.body as Problem).code).toBe('AGENDA_ENTRY_HAS_ENCOUNTER');

      // Y la cita sigue donde estaba: nada se liberó.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: checkedIn },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-040 en la carrera de dos recepcionistas gana exactamente una y la otra recibe 409', async () => {
      const entryId = await bookedEntry();

      const [first, second] = await Promise.all([
        transition(entryId, { to: 'CHECKED_IN' }),
        transition(entryId, { to: 'CHECKED_IN' }),
      ]);

      // Quién gana lo decide el UPDATE condicional; la prueba afirma QUIÉN:
      // exactamente una respuesta 200 y exactamente un 409 con el estado que
      // dejó la ganadora.
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      expect((loser.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      // El 409 nombra el estado QUE DEJÓ LA GANADORA, no el que la perdedora
      // leyó: es la información con la que recepción decide qué hacer ahora.
      expect((loser.body as Problem).title).toContain('En sala');

      // Y el historial tiene UNA fila: la de la ganadora.
      await expect(historyOf(entryId)).resolves.toHaveLength(1);

      // Honestidad de la prueba (revisión adversarial P2-2): si el event loop
      // serializó las dos peticiones, la perdedora se rechazó por la TABLA
      // (leyó CHECKED_IN) y no por el UPDATE condicional — ambos caminos son
      // observacionalmente idénticos a propósito. La forma del WHERE que
      // cierra el interleaving real está clavada por el spec unitario del
      // adaptador; esta prueba garantiza el contrato externo de la carrera.
    });

    it('AG-071 responde 404 para la entrada de otra sede pedida por la URL propia', async () => {
      const foreign = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: otherSiteId,
          practitionerId,
          patientId,
          startsAt: '2026-01-05T15:00:00Z',
          endsAt: '2026-01-05T15:20:00Z',
          bookingChannel: 'PHONE',
          createdById: userId,
        },
      });

      // Por la URL de la sede propia: la entrada existe, pero decir «existe
      // en otra sede» confirmaría citas ajenas a quien prueba identificadores.
      const notFound = await transition(foreign.id, { to: 'CONFIRMED' }).expect(
        404,
      );
      expect((notFound.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');

      // Por la URL de la sede ajena el guard corta antes: 403, no 404.
      const denied = await transition(
        foreign.id,
        { to: 'CONFIRMED' },
        otherSiteId,
      ).expect(403);
      expect((denied.body as Problem).code).toBe('SITE_SCOPE_DENIED');

      // Y la entrada ajena no se movió por ninguno de los dos caminos.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: foreign.id },
      });
      expect(stored.status).toBe('BOOKED');
    });

    it('AG-070 exige sesión para cambiar el estado', async () => {
      const entryId = await bookedEntry();

      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/status`)
        .send({ to: 'CONFIRMED' })
        .expect(401);
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * AG-114 — UN BLOQUEO CREADO POR ERROR TIENE MARCHA ATRÁS
   * ═══════════════════════════════════════════════════════════════════════
   *
   * La máquina de estados rechaza toda transición de un `BLOCK`, así que
   * hasta ahora la única salida era la base de datos. Un control sin deshacer
   * se rodea: se deja de usar el bloqueo y la ausencia del médico se gestiona
   * por fuera del sistema.
   *
   * LIBERAR Y NO BORRAR, por lo mismo que AG-050 en la reprogramación: la
   * fila es la prueba de que ese intervalo estuvo cerrado.
   */
  describe('deshacer un bloqueo', () => {
    it('AG-114 libera el intervalo: el cupo vuelve a ser reservable y la fila sigue ahí', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;

      // Mientras el bloqueo ocupa calendario, el `EXCLUDE` del profesional
      // rechaza la cita: es lo que hace honesta la comprobación de después.
      await book().expect(409);

      const released = await releaseBlock(blockId).expect(200);
      expect((released.body as EntryBody).releasedAt).not.toBeNull();

      // La prueba de que liberar libera DE VERDAD: el mismo intervalo pasa
      // ahora por `agenda_entry_no_practitioner_overlap`.
      await book().expect(201);

      // Y la fila NO se borró: sigue siendo la prueba de que ese martes
      // alguien cerró el quirófano.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: blockId },
      });
      expect(stored.kind).toBe('BLOCK');
      expect(stored.status).toBe('CANCELLED');
      expect(stored.releasedAt).toBeInstanceOf(Date);
    });

    it('AG-114 deja constancia de quién lo eliminó y cuándo, en el historial', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;

      await releaseBlock(blockId).expect(200);

      // AG-004: la constancia va en `agenda_status_history`, no en un texto
      // libre que nadie puede recorrer.
      const rows = await historyOf(blockId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fromStatus: 'BLOCKED',
        toStatus: 'CANCELLED',
        changedById: userId,
      });
      expect(rows[0]?.changedAt).toBeInstanceOf(Date);
    });

    it('AG-114 el mismo bloqueo no se libera dos veces', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;
      await releaseBlock(blockId).expect(200);

      const again = await releaseBlock(blockId).expect(409);

      expect((again.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      // Y el historial sigue teniendo UNA fila: la de la liberación real.
      await expect(historyOf(blockId)).resolves.toHaveLength(1);
    });

    it('AG-114 una cita no se deshace por la ruta de los bloqueos', async () => {
      const entryId = await bookedEntry();

      const response = await releaseBlock(entryId).expect(404);

      // `/blocks/:id` no nombra citas: contestar otra cosa convertiría la
      // ruta en un oráculo de identificadores (AG-071).
      expect((response.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-114 el bloqueo de otra sede responde 404 por la URL propia y 403 por la ajena', async () => {
      const foreign = await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          status: 'BLOCKED',
          siteId: otherSiteId,
          practitionerId,
          startsAt: '2026-01-05T16:00:00Z',
          endsAt: '2026-01-05T17:00:00Z',
          createdById: userId,
        },
      });

      const notFound = await releaseBlock(foreign.id).expect(404);
      expect((notFound.body as Problem).code).toBe('AGENDA_ENTRY_NOT_FOUND');

      // Por la URL de la sede ajena corta el guard: AG-071 por `param:siteId`.
      const denied = await releaseBlock(foreign.id, otherSiteId).expect(403);
      expect((denied.body as Problem).code).toBe('SITE_SCOPE_DENIED');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: foreign.id },
      });
      expect(stored.status).toBe('BLOCKED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-070 exige sesión para deshacer un bloqueo', async () => {
      const blocked = await block().expect(201);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/agenda/sites/${siteId}/blocks/${(blocked.body as EntryBody).id}`,
        )
        .expect(401);
    });
  });
});
