import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaClinicalNoteRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-note.repository';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
} from '../../src/shared/domain/clinic-time';

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

/**
 * AG-173 (D-153.6). An arrival is recorded only on the appointment's own day,
 * so this file's clock stands on that Monday, at 11:20 in Guayaquil: after
 * every slot this file books (the latest is 11:00; a no-show still needs its
 * start to have passed), and the same day as all of them. Derived from the
 * slot, never typed. An arrival at 08:00 is then 200 minutes late: past the
 * default threshold (AG-119 warns) and inside the widest one a site may set
 * (240, AG-142), which is how a test steps into care without AG-120.
 */
const ON_THE_DAY = new Date(Date.parse(PAST_SLOT.startsAt) + 200 * 60_000);

describe('las transiciones de estado de la cita por HTTP', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: ON_THE_DAY });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
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

  /**
   * AG-120, AG-142. The widest threshold a site may set: the file's arrivals
   * (200 minutes late) go into care without asking for the permission.
   */
  async function insideTheWidestThreshold(): Promise<void> {
    await prisma.siteParameter.update({
      where: { siteId },
      data: { lateArrivalGraceMinutes: 240 },
    });
  }

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

  /** AG-154. Deshace el «quitar»: el mismo bloqueo vuelve a cerrar. */
  const restoreBlock = (entryId: string, site = siteId) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${site}/blocks/${entryId}/restore`)
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

      // AG-128: toda llegada lleva la calificación del art. 10.
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
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

      const response = await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: false,
      }).expect(200);

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

    it('AG-044 anula sin motivo (D-126) y deja la fila de historial', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'CANCELLED' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.cancellationNote).toBeNull();
      const history = await historyOf(entryId);
      expect(history).toHaveLength(1);
      expect(history[0]?.note).toBeNull();
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

    it('AG-045 rechaza anular cuando ya hay una atención registrada', async () => {
      // El encuentro se cuelga de una cita en CHECKED_IN a propósito:
      // IN_PROGRESS → CANCELLED ni siquiera está en la tabla, y esta prueba
      // debe aislar el veto de AG-045 del rechazo de tabla de AG-040.
      const checkedIn = await bookedEntry();
      await transition(checkedIn, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
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
        'La cita ya tiene una atención: no puede anularse ni darse por no atendida. Si la atención se abrió por error, se anula desde la atención',
      );

      // Y la cita sigue donde estaba: nada se liberó.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: checkedIn },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-045 rechaza marcar inasistencia cuando ya hay una atención registrada', async () => {
      /**
       * DESDE `CONFIRMED` Y YA NO DESDE `CHECKED_IN`, y el cambio es AG-116:
       * `CHECKED_IN → NO_SHOW` salió de la tabla, así que sobre una cita a la
       * que el paciente llegó el rechazo vendría de AG-040 y esta prueba
       * dejaría de comprobar el veto de AG-045. La atención se cuelga de una
       * cita CONFIRMADA —nada impide abrirla— y el veto se aísla.
       */
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CONFIRMED' }).expect(200);
      await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: entryId,
      });

      const noShow = await transition(entryId, { to: 'NO_SHOW' }).expect(409);
      expect((noShow.body as Problem).code).toBe('AGENDA_ENTRY_HAS_ENCOUNTER');

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CONFIRMED');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-040 en la carrera de dos recepcionistas gana exactamente una y la otra recibe 409', async () => {
      const entryId = await bookedEntry();

      const [first, second] = await Promise.all([
        transition(entryId, { to: 'CHECKED_IN', emergency: false }),
        transition(entryId, { to: 'CHECKED_IN', emergency: false }),
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
  /**
   * AG-186, AG-038 (D-207 §8). Leave of several days: ONE block from the
   * first day at 00:00 to the day after the last, and its refusal naming the
   * appointments of any site with their day.
   */
  describe('el bloqueo de varios días (AG-186)', () => {
    /** Monday of the week after the file's clock, in Guayaquil. */
    const nextMonday = addDays(clinicalDateOf(ON_THE_DAY), 7);
    const midnight = (offsetDays: number) =>
      atWallClock(
        addDays(nextMonday, offsetDays),
        WallClockTime.parse('00:00'),
      );
    const slotsOn = async (from: number, to: number) =>
      (
        (
          await request(app.getHttpServer())
            .get(
              `/api/v1/agenda/sites/${siteId}/availability?practitionerId=${practitionerId}&from=${addDays(nextMonday, from)}&to=${addDays(nextMonday, to)}`,
            )
            .set('Authorization', `Bearer ${token}`)
            .expect(200)
        ).body as { slots: { startsAt: string }[] }
      ).slots.map((slot) => clinicalDateOf(new Date(slot.startsAt)));

    beforeEach(async () => {
      // Tuesday to Saturday too (Monday is the file's rule).
      for (const weekday of [2, 3, 4, 5, 6]) {
        await createScheduleRule(
          prisma,
          { practitionerId, siteId },
          { weekday, startTime: '08:00', endTime: '12:00' },
        );
      }
    });

    it('AG-186 un solo bloqueo de lunes a viernes quita los cupos de los cinco días, deja el sábado, y se quita y se deshace entero', async () => {
      // Control: before the block, the six days offer slots.
      expect(new Set(await slotsOn(0, 5)).size).toBe(6);

      const created = await block({
        startsAt: midnight(0).toISOString(),
        endsAt: midnight(5).toISOString(),
        reason: 'Vacaciones',
      }).expect(201);
      const blockId = (created.body as EntryBody).id;

      expect(new Set(await slotsOn(0, 5))).toEqual(
        new Set([addDays(nextMonday, 5)]),
      );
      expect(
        await prisma.agendaEntry.count({
          where: { practitionerId, kind: 'BLOCK' },
        }),
      ).toBe(1);

      await releaseBlock(blockId).expect(200);
      expect(new Set(await slotsOn(0, 5)).size).toBe(6);
      await restoreBlock(blockId).expect(200);
      expect(new Set(await slotsOn(0, 5))).toEqual(
        new Set([addDays(nextMonday, 5)]),
      );
    });

    it('AG-038 la semana con citas en dos sedes se rechaza enumerándolas con su día, sin nombrar la otra sede', async () => {
      await linkPractitionerToSite(prisma, practitionerId, otherSiteId);
      await createScheduleRule(
        prisma,
        { practitionerId, siteId: otherSiteId },
        { weekday: 3, startTime: '14:00', endTime: '18:00' },
      );
      const monday = atWallClock(nextMonday, WallClockTime.parse('08:00'));
      await bookedEntry({
        startsAt: monday.toISOString(),
        endsAt: new Date(monday.getTime() + 20 * 60_000).toISOString(),
      });
      const wednesday = atWallClock(
        addDays(nextMonday, 2),
        WallClockTime.parse('15:00'),
      );
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: otherSiteId,
          practitionerId,
          patientId: (await createPatient(prisma)).id,
          startsAt: wednesday,
          endsAt: new Date(wednesday.getTime() + 20 * 60_000),
          status: 'BOOKED',
          bookingChannel: 'PHONE',
        },
      });

      const refused = await block({
        startsAt: midnight(0).toISOString(),
        endsAt: midnight(5).toISOString(),
      }).expect(409);

      const problem = refused.body as Problem;
      expect(problem.code).toBe('BLOCK_OVERLAPS_APPOINTMENTS');
      const message = problem.errors?.[0]?.message ?? '';
      expect(message).toMatch(/^Hay 2 citas dentro de ese intervalo: \S+ \d{2}\/\d{2} 08:00, \S+ \d{2}\/\d{2} 15:00$/); // prettier-ignore
      expect(message).not.toContain('Sede Sur');
      // Control: a block of Thursday and Friday, with nothing inside, passes.
      await block({
        startsAt: midnight(3).toISOString(),
        endsAt: midnight(5).toISOString(),
      }).expect(201);
    });
  });

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

    it('AG-154 deshacer el «quitar» vuelve a cerrar la MISMA fila, con su historial', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;
      await releaseBlock(blockId).expect(200);

      const restored = await restoreBlock(blockId).expect(200);

      expect((restored.body as EntryBody).releasedAt).toBeNull();
      // Cierra de verdad: el `EXCLUDE` del profesional vuelve a verla.
      await book().expect(409);
      const rows = await historyOf(blockId);
      expect(rows.map((row) => [row.fromStatus, row.toStatus])).toEqual([
        ['BLOCKED', 'CANCELLED'],
        ['CANCELLED', 'BLOCKED'],
      ]);
      expect(rows[1]).toMatchObject({ changedById: userId });
    });

    it('AG-154 si alguien reservó en el hueco, el bloqueo no se reabre y la cita se queda', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;
      await releaseBlock(blockId).expect(200);
      // Control positivo: el hueco quedó libre y se reserva.
      await book().expect(201);

      await restoreBlock(blockId).expect(409);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: blockId },
      });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.releasedAt).toBeInstanceOf(Date);
      await expect(historyOf(blockId)).resolves.toHaveLength(1);
    });

    it('AG-154 un bloqueo que sigue en pie no se «reabre»', async () => {
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;

      const response = await restoreBlock(blockId).expect(409);

      expect((response.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      await expect(historyOf(blockId)).resolves.toHaveLength(0);
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

  /**
   * E8: los dos desenlaces nuevos, la llegada y la calificación del art. 10,
   * contra PostgreSQL de verdad.
   *
   * LO QUE SÓLO ESTA SUITE PRUEBA: que `LEFT_WITHOUT_BEING_SEEN` y
   * `ENTERED_IN_ERROR` son valores que el enum `agenda_status` ADMITE de
   * verdad para una cita, que su `released_at` libera los tres `EXCLUDE USING
   * gist` —el mismo cupo se vuelve a reservar—, que `agenda_entry_kind_status
   * _coherence` los prohíbe en un bloqueo sin que nadie tocara el CHECK, y que
   * las columnas del art. 10 quedan escritas con su autor bajo
   * `agenda_entry_emergency_flag_follows_assessment`.
   */
  describe('los desenlaces nuevos y la llegada (E8)', () => {
    /** Reserva, registra la llegada con la calificación, y devuelve el id. */
    async function arrivedEntry(
      overrides: Record<string, unknown> = {},
    ): Promise<string> {
      const entryId = await bookedEntry();
      await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: false,
        ...overrides,
      }).expect(200);
      return entryId;
    }

    it('AG-116 libera el cupo al marcar que se fue sin ser atendido, y el cupo se vuelve a reservar', async () => {
      const entryId = await arrivedEntry();

      const response = await transition(entryId, {
        to: 'LEFT_WITHOUT_BEING_SEEN',
      }).expect(200);

      expect((response.body as EntryBody).status).toBe(
        'LEFT_WITHOUT_BEING_SEEN',
      );
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.releasedAt).toBeInstanceOf(Date);
      // AG-127: y sale del tablero, que es el único desenlace que si no
      // dejaría a alguien ahí para siempre — no pasa por caja.
      expect(stored.subjectStatus).toBe('DEPARTED');
      expect(stored.subjectStatusAt).toBeInstanceOf(Date);

      // LA PRUEBA DE QUE LIBERAR LIBERA DE VERDAD: el mismo profesional, el
      // mismo paciente y el mismo horario vuelven a pasar por los tres
      // `EXCLUDE USING gist`. Si `released_at` no fuera su predicado, esto
      // respondería 409.
      await book().expect(201);
    });

    it('AG-116 admite el motivo opcional y lo deja en el historial', async () => {
      const withReason = await arrivedEntry();
      await transition(withReason, {
        to: 'LEFT_WITHOUT_BEING_SEEN',
        reason: 'Se cansó de esperar',
      }).expect(200);

      const rows = await historyOf(withReason);
      expect(rows.at(-1)).toMatchObject({
        fromStatus: 'CHECKED_IN',
        toStatus: 'LEFT_WITHOUT_BEING_SEEN',
        changedById: userId,
        note: 'Se cansó de esperar',
      });
    });

    it('AG-116 rechaza marcar inasistencia a quien registró su llegada', async () => {
      // EL CAMBIO ENTERO: marcar «no vino» a quien está de pie en la sala de
      // espera escribe un hecho falso en un historial append-only y lo mete en
      // el numerador de AG-080 junto a las inasistencias de verdad.
      const entryId = await arrivedEntry();

      const response = await transition(entryId, { to: 'NO_SHOW' }).expect(409);

      expect((response.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.noShowAt).toBeNull();
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-116 rechaza el desenlace desde una cita a la que nadie llegó', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, {
        to: 'LEFT_WITHOUT_BEING_SEEN',
      }).expect(409);

      expect((response.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
    });

    it('AG-117 retracta una cita sin motivo (D-126)', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'ENTERED_IN_ERROR' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('ENTERED_IN_ERROR');
      expect(stored.enteredInErrorReason).toBeNull();
    });

    it('AG-117 libera el cupo sin escribir nada de una anulación', async () => {
      const entryId = await bookedEntry();

      await transition(entryId, {
        to: 'ENTERED_IN_ERROR',
        reason: 'Cédula equivocada',
      }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('ENTERED_IN_ERROR');
      expect(stored.releasedAt).toBeInstanceOf(Date);
      // NO es una anulación: `cancellation_note` es donde se explica por qué
      // se anuló una cita que existía, y una sola columna para los dos actos
      // haría incomprobable desde la fila cuál de ellos ocurrió.
      expect(stored.cancelledAt).toBeNull();
      expect(stored.cancellationNote).toBeNull();
      // El rastro es la fila append-only del historial (AG-004, AG-005).
      const rows = await historyOf(entryId);
      expect(rows.at(-1)?.note).toBe('Cédula equivocada');
      // Y el cupo queda libre de verdad.
      await book().expect(201);
    });

    it('AG-117 rechaza retractar una cita a la que el paciente ya llegó', async () => {
      const entryId = await arrivedEntry();

      const response = await transition(entryId, {
        to: 'ENTERED_IN_ERROR',
        reason: 'Me equivoqué',
      }).expect(409);

      expect((response.body as Problem).code).toBe('INVALID_AGENDA_TRANSITION');
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CHECKED_IN');
    });

    it('AG-046 la base sigue prohibiendo los dos estados nuevos en un bloqueo', async () => {
      /**
       * `agenda_entry_kind_status_coherence` ENUMERA los estados válidos para
       * `kind = BLOCK` y sólo EXCLUYE `BLOCKED` para `APPOINTMENT`, así que un
       * valor nuevo nace admitido para las citas y prohibido para los
       * bloqueos. Eso es una afirmación sobre la BASE y no sobre el código, y
       * la única forma honesta de comprobarla es escribir por debajo del
       * módulo y ver que PostgreSQL la rechaza.
       */
      const blocked = await block().expect(201);
      const blockId = (blocked.body as EntryBody).id;

      // La fila se escribe VÁLIDA POR LO DEMÁS —con el instante y el motivo
      // que `20260820121023_agenda_outcomes_and_board` exige— para que lo que
      // la rechace sea la incoherencia de `kind`, que es lo que se comprueba,
      // y no un `CHECK` de coherencia del desenlace disparando antes.
      const columns: Record<string, string> = {
        LEFT_WITHOUT_BEING_SEEN: `"left_without_being_seen_at" = now()`,
        ENTERED_IN_ERROR: `"entered_in_error_at" = now(), "entered_in_error_reason" = 'prueba'`,
      };
      for (const status of ['LEFT_WITHOUT_BEING_SEEN', 'ENTERED_IN_ERROR']) {
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE "agenda_entry"
                SET "status" = $1::"agenda_status", ${columns[status]}
              WHERE "id" = $2::uuid`,
            status,
            blockId,
          ),
        ).rejects.toThrow(/agenda_entry_kind_status_coherence/);
      }
    });

    it('AG-118 devuelve el retraso de llegada calculado, con su signo', async () => {
      // La cita es del 5 de enero de 2026 y la llegada es ahora: el retraso es
      // un número grande y POSITIVO, y sigue siendo un número y no un estado
      // —`CHECKED_IN` es cierto al mismo tiempo—.
      const entryId = await bookedEntry();

      const response = await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: false,
      }).expect(200);

      const body = response.body as EntryBody & {
        arrivalDelayMinutes: number;
        checkedInAt: string;
        subjectStatus: string;
        warnings: string[];
      };
      expect(body.status).toBe('CHECKED_IN');
      expect(body.arrivalDelayMinutes).toBeGreaterThan(0);
      expect(body.checkedInAt).toEqual(expect.any(String));
      // AG-127: el único estado de paciente que se teclea, escrito por el
      // efecto de la llegada.
      expect(body.subjectStatus).toBe('ARRIVED');

      // Y NO ES UNA COLUMNA: el retraso no se guarda en ninguna parte.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(Object.keys(stored)).not.toContain('arrivalDelayMinutes');
    });

    it('AG-119, AG-142 advierten con el umbral de la sede y NO rechazan la llegada', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: false,
      }).expect(200);

      const body = response.body as EntryBody & { warnings: string[] };
      // Advierte, y la llegada queda registrada: un registro de llegada que se
      // pueda rechazar es un registro que algún día no se hace, y con él se
      // pierde la calificación del art. 10 que el art. 13 respalda con prisión.
      expect(body.status).toBe('CHECKED_IN');
      expect(body.warnings).toHaveLength(1);
      // El umbral de fábrica de `site_parameter.late_arrival_grace_minutes`.
      expect(body.warnings[0]).toContain('15');
    });

    it('AG-142, AG-098 cambiar el umbral cambia la advertencia siguiente y no toca las llegadas ya registradas', async () => {
      /**
       * LAS CITAS SE ESCRIBEN DIRECTAMENTE Y NO POR LA RUTA DE RESERVA, y es
       * lo que hace comprobable el umbral: las del resto del fichero son del
       * 5 de enero de 2026 a propósito, así que su retraso es de meses y
       * ningún valor que quepa en el `SMALLINT` de la columna lo cubre. Aquí
       * hacen falta dos llegadas a un lado y otro de un umbral realista.
       */
      const entryAt = async (minutesAgo: number): Promise<string> => {
        const startsAt = new Date(Date.now() - minutesAgo * 60_000);
        const created = await prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            siteId,
            practitionerId,
            patientId,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 20 * 60_000),
            bookingChannel: 'PHONE',
            createdById: userId,
          },
        });
        return created.id;
      };

      // Con los quince minutos de fábrica, una llegada cuarenta minutos tarde
      // se advierte.
      const late = await entryAt(40);
      const lateResponse = await transition(late, {
        to: 'CHECKED_IN',
        emergency: false,
      }).expect(200);
      expect((lateResponse.body as { warnings: string[] }).warnings).toHaveLength(1); // prettier-ignore
      const lateStored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: late },
      });

      // La sede sube el margen. AG-095: es la sede la que decide, no el
      // código, y REQ-145 prohíbe que el número viva en un `if`.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { lateArrivalGraceMinutes: 200 },
      });

      /**
       * UN RETRASO MAYOR QUE EL PRIMERO Y AUN ASÍ SIN ADVERTENCIA, que es lo
       * que hace la prueba concluyente: la única explicación posible de que
       * calle es el umbral. (Los intervalos no se solapan porque
       * `agenda_entry_no_practitioner_overlap` no lo admitiría, y esa
       * restricción está probada aparte.)
       */
      const alsoLate = await entryAt(100);
      const secondResponse = await transition(alsoLate, {
        to: 'CHECKED_IN',
        emergency: false,
      }).expect(200);
      expect((secondResponse.body as { warnings: string[] }).warnings).toEqual([]); // prettier-ignore

      // AG-098: la llegada ya registrada no se movió al cambiar el parámetro.
      const stillThere = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: late },
      });
      expect(stillThere.checkedInAt).toEqual(lateStored.checkedInAt);
    });

    it('AG-128 rechaza por campo el registro de llegada sin calificación de emergencia', async () => {
      const entryId = await bookedEntry();

      const response = await transition(entryId, { to: 'CHECKED_IN' }).expect(
        422,
      );

      // Por campo, para que la pantalla de llegada resalte la casilla. El
      // `code` es el genérico del transporte porque el DTO rechaza antes que
      // el servicio, como en AG-044; el código estable
      // `EMERGENCY_ASSESSMENT_REQUIRED` lo ve el llamante interno.
      const problem = response.body as Problem;
      expect(problem.errors?.[0]?.field).toBe('emergency');
      expect(problem.errors?.[0]?.message).toBe(
        'Indique sí o no: la calificación es obligatoria al llegar',
      );
      // Y no se registró llegada ninguna: la Ley 77 art. 10 obliga a calificar
      // AL ARRIBO, así que una llegada sin calificar no puede quedar escrita.
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('BOOKED');
      expect(stored.emergencyAssessedAt).toBeNull();
    });

    it('AG-128 escribe el ACTO de calificar aunque la respuesta sea negativa', async () => {
      // LA MITAD QUE LA LEY NECESITA: con sólo la marca afirmativa, `NULL` no
      // distingue «se calificó y no era una emergencia» de «nadie calificó
      // nada», y es lo segundo lo que el art. 13 convierte en prisión.
      const entryId = await arrivedEntry();

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.emergencyAssessedAt).toBeInstanceOf(Date);
      expect(stored.emergencyAssessedById).toBe(userId);
      expect(stored.emergencyFlaggedAt).toBeNull();
      expect(stored.emergencyFlaggedById).toBeNull();
    });

    it('AG-128 escribe el acto y su resultado cuando la calificación es afirmativa', async () => {
      const entryId = await arrivedEntry({
        emergency: true,
        emergencyNote: 'Dolor torácico',
      });

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      // `agenda_entry_emergency_flag_follows_assessment` rechaza una marca sin
      // calificación detrás: el resultado presupone el acto.
      expect(stored.emergencyAssessedAt).toBeInstanceOf(Date);
      expect(stored.emergencyFlaggedAt).toBeInstanceOf(Date);
      expect(stored.emergencyFlaggedById).toBe(userId);
      expect(stored.emergencyNote).toBe('Dolor torácico');
    });

    it('AG-128 la base rechaza una marca de emergencia sin calificación detrás', async () => {
      // Es garantía de la base y no del servicio: una escritura por fuera del
      // módulo tiene que chocar igual.
      const entryId = await bookedEntry();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "agenda_entry"
             SET "emergency_flagged_at" = NOW(), "emergency_flagged_by_id" = $1::uuid
           WHERE "id" = $2::uuid`,
          userId,
          entryId,
        ),
      ).rejects.toThrow(/agenda_entry_emergency_flag_follows_assessment/);
    });

    it('AG-130 no exige ningún permiso distinto del que registra la llegada', async () => {
      // EL TERCER «no» ES EL QUE LO HACE EXIGIBLE: un permiso propio
      // significaría recepcionistas que no pueden calificar, y entonces el
      // art. 10 se incumple los días que esa persona está en el mostrador. La
      // sesión de este fichero es RECEPCION y nada más.
      const entryId = await bookedEntry();

      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(
        200,
      );
    });

    it('AG-131 registra la llegada con la cobertura sin verificar y su motivo', async () => {
      // Ley 77 art. 9: prohibido exigir cheque, tarjeta o cualquier documento
      // de pago antes de recibir y estabilizar. El motivo es lo que distingue
      // un dato que FALTA de uno que se decidió no exigir.
      const entryId = await arrivedEntry({
        coverageCheckSkippedReason: 'Paciente sin documentos, se estabiliza',
      });

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.coverageCheckSkippedReason).toBe(
        'Paciente sin documentos, se estabiliza',
      );
      expect(stored.status).toBe('CHECKED_IN');
    });

    it('AG-131 no condiciona el paso a IN_PROGRESS a que haya forma de pago', async () => {
      const entryId = await arrivedEntry();
      await insideTheWidestThreshold();

      await transition(entryId, { to: 'IN_PROGRESS' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
    });
  });

  /**
   * AG-141. Late arrival over a range, from rows written directly: two
   * timestamps and the site's threshold, nothing typed.
   */
  describe('la llegada tardía de un periodo (AG-141)', () => {
    async function arrivalAt(
      startOffsetMinutes: number,
      delayMinutes: number | null,
      overrides: { bookingChannel?: 'PHONE' | 'WALK_IN'; site?: string } = {},
    ): Promise<void> {
      const startsAt = new Date(
        Date.parse(PAST_SLOT.startsAt) + startOffsetMinutes * 60_000,
      );
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: overrides.site ?? siteId,
          practitionerId,
          patientId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 20 * 60_000),
          bookingChannel: overrides.bookingChannel ?? 'PHONE',
          createdById: userId,
          ...(delayMinutes === null
            ? {}
            : {
                status: 'CHECKED_IN',
                checkedInAt: new Date(
                  startsAt.getTime() + delayMinutes * 60_000,
                ),
                emergencyAssessedAt: new Date(
                  startsAt.getTime() + delayMinutes * 60_000,
                ),
                emergencyAssessedById: userId,
              }),
        },
      });
    }

    it('AG-141 sirve la mediana, las que pasan el umbral de la sede y su denominador, sin las sin cita', async () => {
      await arrivalAt(0, -10);
      await arrivalAt(20, 5);
      await arrivalAt(40, 40);
      // Control: an arrival WITHOUT an appointment does not count, nor one
      // that nobody recorded, nor another site's for a receptionist of this one.
      await arrivalAt(60, 90, { bookingChannel: 'WALK_IN' });
      await arrivalAt(80, null);
      await linkPractitionerToSite(prisma, practitionerId, otherSiteId);
      await arrivalAt(100, 120, { site: otherSiteId });

      const day = clinicalDateOf(new Date(PAST_SLOT.startsAt));
      const response = await request(app.getHttpServer())
        .get(`/api/v1/agenda/metrics/late-arrival?from=${day}&to=${day}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as {
        overall: { arrivals: number; late: number; medianDelayMinutes: number };
        bySite: { siteId: string }[];
        byPractitioner: { practitionerId: string; arrivals: number }[];
      };
      expect(body.overall).toEqual({
        arrivals: 3,
        late: 1,
        medianDelayMinutes: 5,
      });
      expect(body.bySite.map((site) => site.siteId)).toEqual([siteId]);
      expect(body.byPractitioner).toEqual([
        expect.objectContaining({ practitionerId, arrivals: 3 }),
      ]);

      // The threshold is the site's: at 45 minutes, nobody was late.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { lateArrivalGraceMinutes: 45 },
      });
      const wider = await request(app.getHttpServer())
        .get(`/api/v1/agenda/metrics/late-arrival?from=${day}&to=${day}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((wider.body as typeof body).overall.late).toBe(0);
    });
  });

  /**
   * AG-129, AG-175 (D-170.1). The notice of an emergency arrival: born in the
   * arrival's transaction, append-only but for «Enterado», and acknowledged
   * only by its recipient — the practitioner of the appointment.
   */
  describe('el aviso de una llegada en emergencia (AG-129, AG-175)', () => {
    /** The practitioner, signed in with a real password and the doctor's role. */
    async function signInAsThePractitioner(): Promise<string> {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      const email = `doctora-${doctor.id}@clinica.ec`;
      await prisma.user.update({
        where: { id: doctor.userId },
        data: {
          email,
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
        data: { userId: doctor.userId, roleId: medico.id, siteId },
      });
      registry.invalidate();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return (response.body as { accessToken: string }).accessToken;
    }

    const mine = (bearer: string) =>
      request(app.getHttpServer())
        .get('/api/v1/agenda/emergency-alerts/mine')
        .set('Authorization', `Bearer ${bearer}`);
    const acknowledge = (bearer: string, alertId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/agenda/emergency-alerts/${alertId}/acknowledgement`)
        .set('Authorization', `Bearer ${bearer}`);

    it('AG-129 la llegada en emergencia avisa al profesional de la cita en la misma transacción, y la negativa a nadie', async () => {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      const entryId = await bookedEntry();
      const response = await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: true,
        emergencyNote: 'Dolor torácico',
      }).expect(200);

      const alerts = await prisma.agendaEmergencyAlert.findMany({
        where: { agendaEntryId: entryId },
      });
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        recipientId: doctor.userId,
        raisedById: userId,
        siteId,
        acknowledgedAt: null,
      });
      // The same instant as the call: one transaction, one clock.
      expect(alerts[0]?.alertedAt).toEqual(stored.emergencyFlaggedAt);
      // And the detail says whom it notified.
      expect(
        (response.body as { emergencyAlerts: { recipientName: string }[] })
          .emergencyAlerts,
      ).toEqual([expect.objectContaining({ recipientName: 'Ana Villacís' })]);

      // Control: «no era una emergencia» notifies nobody.
      const other = await bookedEntry({
        startsAt: PAST_SLOT.endsAt,
        endsAt: new Date(Date.parse(PAST_SLOT.endsAt) + 20 * 60_000).toISOString(), // prettier-ignore
      });
      await transition(other, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
      expect(
        await prisma.agendaEmergencyAlert.count({
          where: { agendaEntryId: other },
        }),
      ).toBe(0);
    });

    it('AG-175 la base no deja reescribir ni borrar el aviso, y el enterado se escribe una sola vez', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const alert = await prisma.agendaEmergencyAlert.findFirstOrThrow({
        where: { agendaEntryId: entryId },
      });

      await expect(
        prisma.agendaEmergencyAlert.update({
          where: { id: alert.id },
          data: { recipientId: userId },
        }),
      ).rejects.toThrow(/agenda_emergency_alert_is_append_only/);
      await expect(
        prisma.agendaEmergencyAlert.delete({ where: { id: alert.id } }),
      ).rejects.toThrow(/agenda_emergency_alert_is_append_only/);

      // Control positivo: el enterado, una vez, sí.
      const seen = new Date();
      await prisma.agendaEmergencyAlert.update({
        where: { id: alert.id },
        data: { acknowledgedAt: seen },
      });
      await expect(
        prisma.agendaEmergencyAlert.update({
          where: { id: alert.id },
          data: { acknowledgedAt: new Date(seen.getTime() + 60_000) },
        }),
      ).rejects.toThrow(/agenda_emergency_alert_is_append_only/);
    });

    it('AG-175 el destinatario lo ve pendiente y lo marca «Enterado»; nadie más puede', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const doctorToken = await signInAsThePractitioner();

      const pending = await mine(doctorToken).expect(200);
      const items = (pending.body as { items: { id: string; patientName: string; agendaEntryId: string }[] }).items; // prettier-ignore
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        agendaEntryId: entryId,
        patientName: 'Guamán, María',
      });
      const alertId = items[0]!.id;

      // Recepción, que lo disparó, no es su destinataria: el mismo 404 que
      // un aviso que no existe.
      expect((await mine(token).expect(200)).body).toEqual({ items: [] });
      const refused = await acknowledge(token, alertId).expect(404);
      expect((refused.body as Problem).code).toBe('EMERGENCY_ALERT_NOT_FOUND');

      const seen = await acknowledge(doctorToken, alertId).expect(200);
      const at = (seen.body as { acknowledgedAt: string }).acknowledgedAt;
      // Un segundo «Enterado» contesta el primero, sin reescribirlo.
      const again = await acknowledge(doctorToken, alertId).expect(200);
      expect((again.body as { acknowledgedAt: string }).acknowledgedAt).toBe(
        at,
      );
      expect((await mine(doctorToken).expect(200)).body).toEqual({ items: [] });
    });

    it('AG-129 a una cuenta desactivada no se le «avisa»: no queda fila que diga que se avisó', async () => {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      const entryId = await bookedEntry();
      await prisma.user.update({
        where: { id: doctor.userId },
        data: { active: false },
      });

      const response = await transition(entryId, {
        to: 'CHECKED_IN',
        emergency: true,
      }).expect(200);

      // La llegada y la calificación quedan igual (art. 10); el aviso, no.
      expect((response.body as { emergencyFlaggedAt: string | null }).emergencyFlaggedAt).not.toBeNull(); // prettier-ignore
      expect(
        (response.body as { emergencyAlerts: unknown[] }).emergencyAlerts,
      ).toEqual([]);
      expect(
        await prisma.agendaEmergencyAlert.count({
          where: { agendaEntryId: entryId },
        }),
      ).toBe(0);
    });

    it('AG-175 la base no admite un enterado anterior al aviso', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const alert = await prisma.agendaEmergencyAlert.findFirstOrThrow({
        where: { agendaEntryId: entryId },
      });
      await expect(
        prisma.agendaEmergencyAlert.update({
          where: { id: alert.id },
          data: {
            acknowledgedAt: new Date(alert.alertedAt.getTime() - 60_000),
          },
        }),
      ).rejects.toThrow(/agenda_emergency_alert_acknowledged_after_alerted/);
      // Control positivo: en el mismo instante, sí.
      await prisma.agendaEmergencyAlert.update({
        where: { id: alert.id },
        data: { acknowledgedAt: alert.alertedAt },
      });
    });

    it('AG-129 corregir a «sí» con el paciente en sala también avisa', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
      await request(app.getHttpServer())
        .patch(`/api/v1/agenda/sites/${siteId}/entries/${entryId}/emergency`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emergency: true })
        .expect(200);
      expect(
        await prisma.agendaEmergencyAlert.count({
          where: { agendaEntryId: entryId },
        }),
      ).toBe(1);
    });

    /** Another practitioner of the clinic, with a rule of their own. */
    async function colleague(rule: {
      site: string;
      weekday?: number;
      startTime: string;
      endTime: string;
      validTo?: Date;
    }): Promise<{ id: string; userId: string }> {
      const other = await createPractitioner(prisma);
      await linkPractitionerToSite(prisma, other.id, rule.site);
      await createScheduleRule(
        prisma,
        { practitionerId: other.id, siteId: rule.site },
        {
          weekday: rule.weekday ?? 1,
          startTime: rule.startTime,
          endTime: rule.endTime,
          ...(rule.validTo ? { validTo: rule.validTo } : {}),
        },
      );
      return other;
    }

    it('AG-129 avisa además a quien tiene horario en la sede en ese instante, y no a quien lo tiene a otra hora, en otra sede o con un bloqueo encima', async () => {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      // The file's clock is Monday 11:20 in Guayaquil.
      const onDuty = await colleague({ site: siteId, startTime: '08:00', endTime: '12:00' }); // prettier-ignore
      const afternoon = await colleague({ site: siteId, startTime: '14:00', endTime: '18:00' }); // prettier-ignore
      const elsewhere = await colleague({ site: otherSiteId, startTime: '08:00', endTime: '12:00' }); // prettier-ignore
      // The same rule as `onDuty`: the block over the instant is the only
      // difference, which is what makes `onDuty` this case's control.
      const onLeave = await colleague({ site: siteId, startTime: '08:00', endTime: '12:00' }); // prettier-ignore
      // Another weekday, and a rule that ended yesterday (Guayaquil).
      const tuesdays = await colleague({ site: siteId, weekday: 2, startTime: '08:00', endTime: '12:00' }); // prettier-ignore
      const expired = await colleague({
        site: siteId,
        startTime: '08:00',
        endTime: '12:00',
        validTo: new Date(
          `${addDays(clinicalDateOf(ON_THE_DAY), -1)}T00:00:00Z`,
        ),
      });
      await block({
        practitionerId: onLeave.id,
        startsAt: new Date(ON_THE_DAY.getTime() - 60 * 60_000).toISOString(),
        endsAt: new Date(ON_THE_DAY.getTime() + 60 * 60_000).toISOString(),
      }).expect(201);

      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore

      const alerts = await prisma.agendaEmergencyAlert.findMany({
        where: { agendaEntryId: entryId },
      });
      expect(alerts.map((alert) => alert.recipientId).sort()).toEqual(
        [doctor.userId, onDuty.userId].sort(),
      );
      // One instant for all of them: the arrival's.
      expect(new Set(alerts.map((alert) => alert.alertedAt.getTime())).size).toBe(1); // prettier-ignore
      // AG-183 (G1): both were on duty here.
      expect(alerts.every((alert) => alert.onDuty)).toBe(true);
      for (const absent of [afternoon, elsewhere, onLeave, tuesdays, expired]) {
        expect(alerts.some((alert) => alert.recipientId === absent.userId)).toBe(false); // prettier-ignore
      }
    });

    it('AG-129 sin nadie con horario en la sede a esa hora, el aviso va sólo al profesional de la cita', async () => {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      const entryId = await bookedEntry();
      // Booked inside the rule; the rule then stops being in force.
      await prisma.practitionerScheduleRule.updateMany({
        where: { practitionerId },
        data: { active: false },
      });
      await colleague({ site: siteId, startTime: '14:00', endTime: '18:00' });

      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore

      const alerts = await prisma.agendaEmergencyAlert.findMany({
        where: { agendaEntryId: entryId },
      });
      expect(alerts.map((alert) => alert.recipientId)).toEqual([doctor.userId]);
      // AG-183 (G1): told, but not on duty at the site.
      expect(alerts[0]?.onDuty).toBe(false);
    });

    it('AG-173 la llegada en emergencia sobre la cita de mañana la mueve a hoy en el mismo acto, sin calendario y con su versión, aunque el profesional tenga otra cita a esa hora', async () => {
      // Tuesday 6 January, 08:00 in Guayaquil: the day after the file's clock.
      await createScheduleRule(
        prisma,
        { practitionerId, siteId },
        { weekday: 2, startTime: '08:00', endTime: '12:00' },
      );
      const tomorrow = new Date(Date.parse(PAST_SLOT.startsAt) + 24 * 60 * 60_000); // prettier-ignore
      const entryId = await bookedEntry({
        startsAt: tomorrow.toISOString(),
        endsAt: new Date(tomorrow.getTime() + 20 * 60_000).toISOString(),
      });
      // The doctor is busy right now, on the calendar.
      const other = await createPatient(prisma);
      await bookedEntry({
        patientId: other.id,
        startsAt: ON_THE_DAY.toISOString(),
        endsAt: new Date(ON_THE_DAY.getTime() + 20 * 60_000).toISOString(),
      });

      // Control: an ordinary arrival on it is still refused, and moves nothing.
      const refused = await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ARRIVAL_NOT_ON_APPOINTMENT_DAY'); // prettier-ignore

      const response = await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const body = response.body as {
        status: string;
        startsAt: string;
        endsAt: string;
        blocksCalendar: boolean;
        emergencyMovedAt: string | null;
      };
      expect(body).toMatchObject({
        status: 'CHECKED_IN',
        startsAt: ON_THE_DAY.toISOString(),
        endsAt: new Date(ON_THE_DAY.getTime() + 20 * 60_000).toISOString(),
        blocksCalendar: false,
        emergencyMovedAt: ON_THE_DAY.toISOString(),
      });

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.overbookingAuthorisedById).toBeNull();
      expect(stored.editedById).toBe(userId);
      expect(stored.emergencyFlaggedAt).toEqual(ON_THE_DAY);
      // AG-051: the row as it was —tomorrow, on the calendar— is the version.
      const versions = await prisma.recordVersion.findMany({
        where: { resourceType: 'agenda_entry', resourceId: entryId },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.data).toMatchObject({ starts_at: tomorrow.toISOString().replace('.000Z', '+00:00'), blocks_calendar: true }); // prettier-ignore
      // AG-129 in the same transaction.
      expect(
        await prisma.agendaEmergencyAlert.count({ where: { agendaEntryId: entryId } }), // prettier-ignore
      ).toBe(1);
    });

    it('AG-173 la base sólo admite una cita sin calendario y sin autorizador cuando la movió una emergencia', async () => {
      const entryId = await bookedEntry();
      await expect(
        prisma.$executeRaw`
          UPDATE agenda_entry
             SET blocks_calendar = false, edited_by_id = ${userId}::uuid, edited_at = ${new Date(ON_THE_DAY.getTime() + 1000)}
           WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/agenda_entry_overbooking_coherence/);
      // Control positivo: el mismo UPDATE con `emergency_moved_at`, sí.
      await prisma.$executeRaw`
        UPDATE agenda_entry
           SET blocks_calendar = false, emergency_moved_at = ${ON_THE_DAY}, edited_by_id = ${userId}::uuid, edited_at = ${new Date(ON_THE_DAY.getTime() + 2000)}
         WHERE id = ${entryId}::uuid`;
      // And a calendar row can never carry the mark.
      await expect(
        prisma.$executeRaw`
          UPDATE agenda_entry
             SET blocks_calendar = true, edited_by_id = ${userId}::uuid, edited_at = ${new Date(ON_THE_DAY.getTime() + 3000)}
           WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/agenda_entry_overbooking_coherence/);
    });

    it('AG-175 la banda no trae el aviso de una emergencia corregida a «no» con el paciente aún en sala', async () => {
      const corrected = await bookedEntry();
      const still = await bookedEntry({
        startsAt: PAST_SLOT.endsAt,
        endsAt: new Date(Date.parse(PAST_SLOT.endsAt) + 20 * 60_000).toISOString(), // prettier-ignore
      });
      await transition(corrected, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      await transition(still, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      await request(app.getHttpServer())
        .patch(`/api/v1/agenda/sites/${siteId}/entries/${corrected}/emergency`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emergency: false })
        .expect(200);
      const doctorToken = await signInAsThePractitioner();

      const items = ((await mine(doctorToken).expect(200)).body as { items: { agendaEntryId: string }[] }).items; // prettier-ignore
      // Control positivo: la que sigue calificada, sí.
      expect(items.map((item) => item.agendaEntryId)).toEqual([still]);
    });

    it('AG-173 la cita movida por emergencia no gasta el tope de sobrecupos del día (AG-100)', async () => {
      await createScheduleRule(
        prisma,
        { practitionerId, siteId },
        { weekday: 2, startTime: '08:00', endTime: '12:00' },
      );
      await prisma.siteParameter.update({
        where: { siteId },
        data: { overbookingCap: 1 },
      });
      const tomorrow = new Date(Date.parse(PAST_SLOT.startsAt) + 24 * 60 * 60_000); // prettier-ignore
      const moved = await bookedEntry({
        startsAt: tomorrow.toISOString(),
        endsAt: new Date(tomorrow.getTime() + 20 * 60_000).toISOString(),
      });
      await transition(moved, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore

      // The one overbooking of the day still fits: the moved one did not count.
      const authoriser = await prisma.user.create({
        data: { email: `autoriza-${Date.now()}@clinica.ec`, firstName: 'Iván', lastName: 'Mora', passwordHash: 'not-a-real-hash' }, // prettier-ignore
      });
      const medico = await prisma.role.findUniqueOrThrow({ where: { code: 'MEDICO' } }); // prettier-ignore
      await prisma.userRoleGrant.create({ data: { userId: authoriser.id, roleId: medico.id, siteId } }); // prettier-ignore
      registry.invalidate();
      const other = await createPatient(prisma);
      const overbook = () =>
        book({
          patientId: other.id,
          overbooking: true,
          overbookingAuthorisedById: authoriser.id,
          overbookingReason: 'Urgencia',
        });
      await overbook().expect(201);
      // Control: the cap is real — a second one is refused.
      const third = await createPatient(prisma);
      const refused = await book({
        patientId: third.id,
        startsAt: PAST_SLOT.endsAt,
        endsAt: new Date(Date.parse(PAST_SLOT.endsAt) + 20 * 60_000).toISOString(), // prettier-ignore
        overbooking: true,
        overbookingAuthorisedById: authoriser.id,
        overbookingReason: 'Urgencia',
      }).expect(409);
      expect((refused.body as Problem).code).toBe('OVERBOOKING_LIMIT_REACHED');
    });

    it('AG-175 la banda no trae el aviso de una cita que ya salió de la sala; el detalle sigue diciendo a quién se avisó', async () => {
      const waiting = await bookedEntry();
      const gone = await bookedEntry({
        startsAt: PAST_SLOT.endsAt,
        endsAt: new Date(Date.parse(PAST_SLOT.endsAt) + 20 * 60_000).toISOString(), // prettier-ignore
      });
      await transition(waiting, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      await transition(gone, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const cancelled = await transition(gone, { to: 'CANCELLED' }).expect(200);
      const doctorToken = await signInAsThePractitioner();

      const items = ((await mine(doctorToken).expect(200)).body as { items: { agendaEntryId: string }[] }).items; // prettier-ignore
      // Control positivo: la que sigue en sala, sí.
      expect(items.map((item) => item.agendaEntryId)).toEqual([waiting]);
      expect(
        (cancelled.body as { entry?: { emergencyAlerts: unknown[] }; emergencyAlerts?: unknown[] }).entry?.emergencyAlerts ?? // prettier-ignore
          (cancelled.body as { emergencyAlerts: unknown[] }).emergencyAlerts,
      ).toHaveLength(1);
    });
  });

  /**
   * E10 (D-076, D-077, D-080, D-081). What the attention marks on the
   * appointment, against PostgreSQL.
   *
   * THE CAPTURE OF THE AUTHOR (30-09-2026): Carlos Álvarez «En atención» —the
   * doctor had opened his note— and the menu offering «Pasar a atención», «Se
   * fue sin ser atendido» and «Anular…», because the appointment was still
   * `CHECKED_IN`. These tests reproduce it and assert both halves: opening the
   * note moves the appointment, and the server refuses the two outcomes that
   * deny a consultation that happened.
   */
  describe('lo que la atención marca en la cita (E10)', () => {
    /** Cita en sala, con su atención abierta: el paciente ya llegó. */
    async function inTheWaitingRoomWithAttention() {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: false }).expect(200); // prettier-ignore
      const encounter = await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: entryId,
        // On the file's clock (AG-173): opened just now, after the arrival.
        startedAt: new Date(),
      });
      return { entryId, encounter };
    }

    /** La médica abre la nota por el mismo adaptador que usa la API. */
    async function openTheNote(encounterId: string, formCode = '002') {
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      return new PrismaClinicalNoteRepository(
        prisma as unknown as PrismaService,
      ).createDraft({
        encounterId,
        formCode,
        formVersion: '1',
        templateId: null,
        content: { motivoConsulta: 'Dolor abdominal' },
        authorId: practitionerId,
        authorUserId: doctor.userId,
        sites: [siteId],
      });
    }

    it('AG-146 abrir la nota pasa la cita a IN_PROGRESS, con su fila de historial y su autor', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });

      await openTheNote(encounter.id);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
      expect(stored.subjectStatus).toBe('RECEIVING_CARE');
      const last = (await historyOf(entryId)).at(-1);
      expect(last).toMatchObject({
        fromStatus: 'CHECKED_IN',
        toStatus: 'IN_PROGRESS',
        changedById: doctor.userId,
      });
    });

    it('AG-120 abrir la nota de una llegada fuera de plazo no se rechaza y deja quién la admitió (D-170.2)', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });

      await openTheNote(encounter.id);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
      expect(stored.lateAdmissionById).toBe(doctor.userId);
      expect(stored.lateAdmissionAt).toEqual(expect.any(Date));
    });

    it('AG-120 una emergencia que llegó tarde no queda como admitida fuera de plazo al abrir la nota', async () => {
      const entryId = await bookedEntry();
      await transition(entryId, { to: 'CHECKED_IN', emergency: true }).expect(200); // prettier-ignore
      const encounter = await createEncounter(prisma, {
        siteId,
        practitionerId,
        patientId,
        agendaEntryId: entryId,
        startedAt: new Date(),
      });

      await openTheNote(encounter.id);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
      expect(stored.lateAdmissionById).toBeNull();
    });

    it('AG-120 la base exige quién y cuándo de la admisión fuera de plazo, juntos', async () => {
      const { entryId } = await inTheWaitingRoomWithAttention();
      await expect(
        prisma.agendaEntry.update({
          where: { id: entryId },
          data: { lateAdmissionById: userId },
        }),
      ).rejects.toThrow(/agenda_entry_late_admission_names_who_and_when/);
      // Control positivo: los dos.
      await prisma.agendaEntry.update({
        where: { id: entryId },
        data: { lateAdmissionById: userId, lateAdmissionAt: new Date() },
      });
    });

    it('AG-120 dentro del margen, abrir la nota no anota ninguna admisión fuera de plazo (control)', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await insideTheWidestThreshold();

      await openTheNote(encounter.id);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
      expect(stored.lateAdmissionById).toBeNull();
      expect(stored.lateAdmissionAt).toBeNull();
    });

    it('AG-120 la ruta de estado no pasa a atención una llegada tardía sin el permiso de la sede', async () => {
      const { entryId } = await inTheWaitingRoomWithAttention();

      // Recepción no tiene `agenda:overbook`, el permiso de fábrica (D-170.3).
      const refused = await transition(entryId, { to: 'IN_PROGRESS' }).expect(403); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'LATE_ARRIVAL_NOT_AUTHORISED',
      );
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.lateAdmissionById).toBeNull();

      // Control positivo: la sede nombra un permiso que recepción sí tiene.
      await prisma.siteParameter.update({
        where: { siteId },
        data: { lateArrivalOverridePermission: 'agenda:write' },
      });
      await transition(entryId, { to: 'IN_PROGRESS' }).expect(200);
      const admitted = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(admitted.lateAdmissionById).toBe(userId);
    });

    it('AG-142 la base no admite un umbral de más de cuatro horas ni un permiso que no existe', async () => {
      await expect(
        prisma.siteParameter.update({
          where: { siteId },
          data: { lateArrivalGraceMinutes: 241 },
        }),
      ).rejects.toThrow(/site_parameter_late_arrival_grace_range/);
      await expect(
        prisma.siteParameter.update({
          where: { siteId },
          data: { lateArrivalOverridePermission: 'agenda:inventado' },
        }),
        // `foreign_key_violation`, which Prisma reports without the trigger's
        // name (same as `trg_site_parameter_overbooking_permission`).
      ).rejects.toThrow(/[Ff]oreign key/);
      const unchanged = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId },
      });
      expect(unchanged.lateArrivalOverridePermission).toBe('agenda:overbook');
      // Control positivo: el borde y un permiso instalado sí.
      await prisma.siteParameter.update({
        where: { siteId },
        data: {
          lateArrivalGraceMinutes: 240,
          lateArrivalOverridePermission: 'settings:manage',
        },
      });
    });

    it('AG-146 una segunda nota sobre la misma atención no escribe otra fila', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();

      await openTheNote(encounter.id);
      const before = (await historyOf(entryId)).length;
      // EN-229: a second 002 is refused; a note of another form is the
      // second note an attention can legitimately get.
      await openTheNote(encounter.id, '005');

      expect(await historyOf(entryId)).toHaveLength(before);
    });

    it('AG-146 reproduce la captura del autor: con la nota abierta, ni «se fue sin ser atendido» ni «anular»', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await openTheNote(encounter.id);

      for (const body of [
        { to: 'LEFT_WITHOUT_BEING_SEEN' },
        { to: 'CANCELLED', reason: 'Se retiró' },
      ]) {
        const refused = await transition(entryId, body).expect(409);
        expect((refused.body as Problem).code).toBe(
          'INVALID_AGENDA_TRANSITION',
        );
      }

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('IN_PROGRESS');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-045 con nota y la cita aún en CHECKED_IN (filas de antes de AG-146), el servidor también lo rechaza', async () => {
      // Las citas que se quedaron en sala con la nota abierta antes de esta
      // entrega: la tabla admite la salida desde CHECKED_IN, así que el veto
      // tiene que venir de la atención, no de la tabla.
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await prisma.clinicalNote.create({
        data: {
          id: encounter.id,
          chainId: encounter.id,
          version: 1,
          encounterId: encounter.id,
          formCode: '002',
          formVersion: '1',
          status: 'DRAFT',
          // Con algo escrito: una nota vacía no es acto clínico (D-099 §5).
          content: { motivoConsulta: 'Dolor abdominal' },
          authorId: practitionerId,
        },
      });

      for (const body of [
        { to: 'LEFT_WITHOUT_BEING_SEEN' },
        { to: 'CANCELLED', reason: 'Se retiró' },
      ]) {
        const refused = await transition(entryId, body).expect(409);
        expect((refused.body as Problem).code).toBe(
          'AGENDA_ENTRY_HAS_ENCOUNTER',
        );
      }
      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('CHECKED_IN');
      expect(stored.releasedAt).toBeNull();
    });

    it('AG-148 sin nota, «se fue sin ser atendido» se admite e interrumpe la atención en la misma transacción', async () => {
      // Control positivo de la anterior: la misma cita, la misma atención,
      // sin nota. Nadie la atendió, así que la salida es la verdad.
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();

      await transition(entryId, { to: 'LEFT_WITHOUT_BEING_SEEN' }).expect(200);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stored.status).toBe('LEFT_WITHOUT_BEING_SEEN');
      expect(stored.releasedAt).not.toBeNull();
      const interrupted = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounter.id },
      });
      expect(interrupted).toMatchObject({
        status: 'DISCONTINUED',
        discontinuedOrigin: 'PATIENT',
        discontinuedReason: 'Se fue sin ser atendido',
        discontinuedById: userId,
      });
      expect(interrupted.discontinuedAt).toEqual(stored.leftWithoutBeingSeenAt);
    });

    it('AG-150 la cita publica el estado de su atención viva, y no su identificador', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await insideTheWidestThreshold();

      const confirmed = await transition(entryId, {
        to: 'IN_PROGRESS',
      }).expect(200);

      const body = confirmed.body as Record<string, unknown>;
      expect(body.attention).toBe('OPEN');
      expect(JSON.stringify(body)).not.toContain(encounter.id);

      // Control positivo: una cita sin atención publica `null`.
      const bare = await bookedEntry({
        startsAt: PAST_SLOT.endsAt,
        endsAt: new Date(
          Date.parse(PAST_SLOT.endsAt) + 20 * 60_000,
        ).toISOString(),
      });
      const confirmedBare = await transition(bare, { to: 'CONFIRMED' }).expect(200); // prettier-ignore
      expect(
        (confirmedBare.body as Record<string, unknown>).attention,
      ).toBeNull();
    });

    it('AG-148 sobre una atención ya interrumpida, la salida se registra y la interrupción conserva su origen y su motivo', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      const at = new Date();
      await prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'DISCONTINUED',
          endedAt: at,
          discontinuedReason: 'Urgencia en otra sala',
          discontinuedOrigin: 'ESTABLISHMENT',
          discontinuedById: doctor.userId,
          discontinuedAt: at,
        },
      });

      await transition(entryId, { to: 'LEFT_WITHOUT_BEING_SEEN' }).expect(200);

      expect(
        await prisma.encounter.findUniqueOrThrow({
          where: { id: encounter.id },
        }),
      ).toMatchObject({
        discontinuedOrigin: 'ESTABLISHMENT',
        discontinuedReason: 'Urgencia en otra sala',
        discontinuedById: doctor.userId,
      });
    });

    it('AG-148 una receta u orden sin nota también es consulta: la salida se rechaza (D-085 §3)', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await prisma.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          // ORD-100. An issued order: a draft is not an act yet.
          status: 'ISSUED',
        },
      });

      const refused = await transition(entryId, { to: 'LEFT_WITHOUT_BEING_SEEN' }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('AGENDA_ENTRY_HAS_ENCOUNTER');
    });

    it('AG-146 AG-148 abrir la nota y marcar la salida a la vez: gana exactamente uno, nunca los dos', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();

      const [note, departure] = await Promise.allSettled([
        openTheNote(encounter.id),
        transition(entryId, { to: 'LEFT_WITHOUT_BEING_SEEN' }),
      ]);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      const attention = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounter.id },
      });
      const departed =
        departure.status === 'fulfilled' && departure.value.status === 200;
      if (note.status === 'fulfilled') {
        // La nota ganó: hubo consulta, la salida se rechazó.
        expect(departed).toBe(false);
        expect(stored.status).toBe('IN_PROGRESS');
        expect(attention.status).toBe('OPEN');
      } else {
        // La salida ganó: la atención quedó interrumpida y la nota se rechazó.
        expect(departed).toBe(true);
        expect(stored.status).toBe('LEFT_WITHOUT_BEING_SEEN');
        expect(attention.status).toBe('DISCONTINUED');
        expect(await prisma.clinicalNote.count({ where: { encounterId: encounter.id } })).toBe(0); // prettier-ignore
      }
    });

    it('AG-153 «Marcar atendida» se rechaza con la atención en curso y se admite cuando terminó (D-099 §3)', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      await openTheNote(encounter.id);

      const refused = await transition(entryId, { to: 'FULFILLED' }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'ATTENTION_STILL_IN_PROGRESS',
      );

      // Control positivo: firmada la nota, la atención está de alta y la cita
      // ya se puede marcar atendida.
      await prisma.encounter.update({
        where: { id: encounter.id },
        data: { status: 'DISCHARGED', endedAt: new Date(), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });
      await transition(entryId, { to: 'FULFILLED' }).expect(200);
    });

    it('AG-045 una atención anulada ya no frena la cita', async () => {
      const { entryId, encounter } = await inTheWaitingRoomWithAttention();
      const at = new Date();
      await prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'ENTERED_IN_ERROR',
          endedAt: at,
          enteredInErrorReason: 'Ficha equivocada',
          enteredInErrorById: userId,
          enteredInErrorAt: at,
        },
      });

      await transition(entryId, { to: 'CANCELLED', reason: 'Reagenda' }).expect(200); // prettier-ignore
    });
  });
});
