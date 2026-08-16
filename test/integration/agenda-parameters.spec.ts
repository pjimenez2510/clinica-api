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
import { DEFAULT_BOOKING_PARAMETERS } from '../../src/modules/agenda/domain/booking-policy';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import {
  type ClinicalDate,
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  clinicalDaySpan,
  isoWeekdayOf,
  parseClinicalDate,
  wallClockOf,
} from '../../src/shared/domain/clinic-time';
import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The booking window of a site, end to end (E7): AG-031 to AG-033, AG-094,
 * AG-095, AG-098 and AG-102.
 *
 * WHY A DATABASE AND NOT A DOUBLE. Everything here is about values the agenda
 * READS FROM `site_parameter` — a table it does not own, filled by a trigger of
 * another module (CF-062) and reachable only through a port. A double that
 * returns what we programmed proves that the policy multiplies minutes
 * correctly and nothing at all about the column defaults being the ones the
 * code assumes, about the row existing for every site, or about a parameter
 * change leaving the appointments already booked exactly as they were.
 *
 * WHY THE DATES ARE COMPUTED AND NOT PINNED, unlike the rest of the agenda
 * suites. These requirements compare against the CURRENT INSTANT: a fixed
 * Monday is "the future" until the calendar reaches it and then silently
 * becomes the past, at which point the suite would start failing for a reason
 * that has nothing to do with the code. Every date below is derived from
 * `new Date()` and is a Monday, which the schedule rule covers.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion@clinica.ec';
/** Synthetic cedula with a COMPUTED check digit; never a real person's. */
const CEDULA = '1710034065';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

/** The first Monday at least `minDaysAhead` days from that instant, in Ecuador. */
function mondayAhead(from: Date, minDaysAhead: number): ClinicalDate {
  let date = addDays(clinicalDateOf(from), minDaysAhead);
  while (isoWeekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}

/** The last Monday at least `minDaysBack` days before that instant. */
function mondayBefore(from: Date, minDaysBack: number): ClinicalDate {
  let date = addDays(clinicalDateOf(from), -minDaysBack);
  while (isoWeekdayOf(date) !== 1) date = addDays(date, -1);
  return date;
}

/** That Ecuadorian date at that wall clock, as the instant it really is. */
const at = (date: ClinicalDate, time: string): Date =>
  atWallClock(date, WallClockTime.parse(time));

/**
 * The instant a Spanish sentence announces, back from `dd/mm/aaaa a las hh:mm`.
 *
 * The message states the ECUADORIAN wall clock, so reading it back through
 * `atWallClock` is the only honest way to compare it with an instant — and it
 * is what makes the assertion fail if the sentence ever starts printing UTC.
 */
function announcedInstant(message: string): Date {
  const match = /(\d{2})\/(\d{2})\/(\d{4}) a las (\d{2}):(\d{2})/.exec(message);
  if (!match) throw new Error(`No instant announced in: ${message}`);
  const [, day, month, year, hour, minute] = match;
  return at(parseClinicalDate(`${year}-${month}-${day}`), `${hour}:${minute}`);
}

describe('los parámetros de reserva de la sede', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let siteId: string;
  let practitionerId: string;
  let patientId: string;

  /** A Monday two to three weeks ahead, and one two to three weeks back. */
  let future: ClinicalDate;
  let past: ClinicalDate;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // El ALMACÉN del limitador, no el guard: `APP_GUARD` cubre también el
        // de autorización, que estas pruebas sí ejercitan.
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

    const now = new Date();
    future = mondayAhead(now, 14);
    past = mondayBefore(now, 14);

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    siteId = site.id;
    practitionerId = practitioner.id;
    patientId = patient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // Lunes, 08:00–12:00, cupos de veinte minutos. La regla vale desde mucho
    // antes del lunes pasado y no caduca, así que cubre los dos extremos.
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      {
        weekday: 1,
        startTime: '08:00',
        endTime: '12:00',
        validFrom: new Date(`${addDays(past, -365)}T00:00:00Z`),
      },
    );

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    // La caché de rol→permisos se indexa por id, y al truncar los roles se
    // recrean con ids nuevos: sin esto todas las peticiones responden 403.
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        cedula: CEDULA,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

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

  /** Twenty minutes from that instant: one slot of the rule. */
  const aSlotAt = (startsAt: Date) => ({
    patientId,
    practitionerId,
    bookingChannel: 'PHONE',
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 20 * 60_000).toISOString(),
  });

  const book = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/agenda/sites/${siteId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const setParameters = (data: {
    minLeadMinutes?: number;
    maxLeadDays?: number;
    allowPastBooking?: boolean;
  }) =>
    // Escrito por Prisma y no por `PUT /sites/:id/parameters` a propósito: la
    // ruta que los guarda es de `configuration` y tiene sus propias pruebas
    // (CF-062, CF-065, CF-066). Lo que se prueba aquí es qué hace la AGENDA
    // con el valor una vez guardado, y hacerla pasar por el endpoint del otro
    // módulo obligaría a fabricar un administrador para cada caso.
    prisma.siteParameter.update({ where: { siteId }, data });

  describe('AG-031 · reservar en el pasado', () => {
    it('AG-031 rechaza una cita que empieza antes de ahora con BOOKING_IN_THE_PAST', async () => {
      const response = await book(aSlotAt(at(past, '08:00'))).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('BOOKING_IN_THE_PAST');
      expect(problem.title).toBe(
        'La cita no puede empezar en una hora que ya pasó. Elija una hora futura',
      );
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(problem.errors?.[0]).toMatchObject({
        field: 'startsAt',
        code: 'BOOKING_IN_THE_PAST',
      });
      // Y no escribió nada: el rechazo es anterior a cualquier INSERT.
      await expect(prisma.agendaEntry.count()).resolves.toBe(0);
    });

    it('AG-031 admite el registro a posteriori cuando la sede lo habilita', async () => {
      // El camino completo de reserva sobre una fecha pasada: regla de
      // horario, alineación al cupo, INSERT y los tres `EXCLUDE`. Lo único
      // que cambia respecto de la prueba anterior es una columna de la sede.
      await setParameters({ allowPastBooking: true });

      const startsAt = at(past, '08:00');
      const response = await book(aSlotAt(startsAt)).expect(201);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      expect(stored.startsAt.toISOString()).toBe(startsAt.toISOString());
      expect(stored.status).toBe('BOOKED');
      expect(stored.siteId).toBe(siteId);
    });

    it('AG-094 crea la sede con el pasado cerrado, y es la base quien lo escribe', async () => {
      // El disparador de CF-062 le pone la fila a TODA sede; el defecto
      // conservador es la decisión de la migración: que una sede abra el
      // pasado es suyo, que venga abierta de fábrica sería nuestro.
      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId },
      });

      expect(stored.allowPastBooking).toBe(false);
    });
  });

  describe('AG-032 · la antelación mínima', () => {
    it('AG-032 rechaza una reserva con menos antelación que la mínima e indica el primer instante admisible', async () => {
      await setParameters({ minLeadMinutes: 600 });

      const asked = new Date();
      const response = await book(
        aSlotAt(new Date(asked.getTime() + 5 * 60_000)),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('BOOKING_TOO_SOON');
      expect(problem.status).toBe(422);
      expect(problem.errors?.[0]?.field).toBe('startsAt');

      // La segunda mitad del requisito: el mensaje dice DESDE CUÁNDO, y lo
      // dice en la hora de Ecuador. Se compara con tolerancia porque el
      // servidor lee su propio reloj y la frase omite los segundos.
      const announced = announcedInstant(problem.errors?.[0]?.message ?? '');
      const expected = asked.getTime() + 600 * 60_000;
      expect(Math.abs(announced.getTime() - expected)).toBeLessThan(90_000);
      // Y es la hora de pared ecuatoriana, no el instante UTC: a las 09:00 de
      // Guayaquil el mensaje jamás puede decir 14:00.
      expect(problem.errors?.[0]?.message).toContain(
        wallClockOf(announced).toString(),
      );
    });

    it('AG-032 no aplica la antelación mínima a la reserva presencial', async () => {
      // El paciente ya está en el mostrador. Se comprueba por diferencia con
      // el caso anterior: MISMO instante, misma sede, mismo parámetro, y el
      // único cambio es el canal. Lo que se afirma es que la ventana no lo
      // rechaza; que una reserva presencial legítima se cree entera lo prueba
      // el caso puro, porque un instante a cinco minutos de ahora no cae
      // dentro de ninguna regla de horario fija.
      await setParameters({ minLeadMinutes: 600 });

      const response = await book({
        ...aSlotAt(new Date(Date.now() + 5 * 60_000)),
        bookingChannel: 'WALK_IN',
      });

      expect((response.body as Problem).code).not.toBe('BOOKING_TOO_SOON');
    });
  });

  describe('AG-033 · la antelación máxima', () => {
    it('AG-033 rechaza una fecha más allá de la antelación máxima e indica la última admisible', async () => {
      // Siete días, con el lunes objetivo a catorce o más: fuera de ventana
      // sin depender de qué día de la semana corra la prueba.
      await setParameters({ maxLeadDays: 7 });

      const response = await book(aSlotAt(at(future, '08:00'))).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('BOOKING_TOO_FAR');
      expect(problem.title).toBe(
        'La cita se pide con demasiada antelación para esta sede. Elija una fecha más cercana',
      );

      // La última fecha admisible, contada en el calendario ecuatoriano.
      const limit = addDays(clinicalDateOf(new Date()), 7);
      const [year, month, day] = limit.split('-');
      expect(problem.errors?.[0]?.message).toBe(
        `La última fecha que puede reservarse es el ${day}/${month}/${year}`,
      );
    });

    it('AG-033 admite la última fecha admisible entera, hasta su última hora', async () => {
      // El límite es una FECHA: con la antelación máxima puesta justo en el
      // lunes objetivo, las 11:40 de ese día se reservan igual que las 08:00.
      // Medido como instante, la misma cita se rechazaría o no según la hora
      // a la que corriera la prueba.
      const days = clinicalDaySpan(clinicalDateOf(new Date()), future) - 1;
      await setParameters({ maxLeadDays: days });

      await book(aSlotAt(at(future, '11:40'))).expect(201);
    });

    it('AG-033 rechaza el día siguiente al último admisible', async () => {
      // El otro lado del mismo borde, para que la prueba de arriba no pueda
      // pasar por un límite generoso de más.
      const days = clinicalDaySpan(clinicalDateOf(new Date()), future) - 2;
      await setParameters({ maxLeadDays: days });

      const response = await book(aSlotAt(at(future, '08:00'))).expect(422);
      expect((response.body as Problem).code).toBe('BOOKING_TOO_FAR');
    });
  });

  describe('AG-095 · el parámetro que la sede no define', () => {
    it('AG-095 reserva con los valores por defecto del código cuando la sede no tiene fila', async () => {
      // La fila la escribe un disparador y no debería faltar nunca; un volcado
      // restaurado a medias o una importación la dejan faltar igual, y la
      // agenda tiene que seguir sabiendo con qué opera.
      await prisma.siteParameter.delete({ where: { siteId } });

      // Antelación mínima 0 y máxima 180 días: el lunes de dentro de dos
      // semanas entra.
      await book(aSlotAt(at(future, '08:00'))).expect(201);

      // Y el pasado sigue cerrado, que es el defecto del código.
      const refused = await book(aSlotAt(at(past, '08:00'))).expect(422);
      expect((refused.body as Problem).code).toBe('BOOKING_IN_THE_PAST');
    });

    it('AG-095 declara en el código los mismos valores que la base escribe al crear la sede', async () => {
      // Las dos copias existen a propósito —`configuration` declara con qué
      // NACE una sede, la agenda con qué OPERA si no hay nada que leer— y
      // esta prueba es lo que impide que se separen en silencio.
      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId },
      });

      expect({
        minLeadMinutes: stored.minLeadMinutes,
        maxLeadDays: stored.maxLeadDays,
        allowPastBooking: stored.allowPastBooking,
        // D-021: el turno de la agenda es el cuarto, y es el que más falta
        // haría cuadrar — la rejilla derivada sale de él.
        slotAtomMinutes: stored.slotAtomMinutes,
        // E4 (AG-039, AG-100, AG-101): los tres del sobrecupo entraron con la
        // entrega que los lee (D-018), y valen para esto exactamente igual —
        // un interruptor que la base escribiera `false` y el código operara
        // como `true` dejaría la sede sin sobrecupos sólo cuando le falta la
        // fila, que es el caso más difícil de diagnosticar que existe.
        overbookingEnabled: stored.overbookingEnabled,
        overbookingCap: stored.overbookingCap,
        overbookingPermission: stored.overbookingPermission,
      }).toEqual(DEFAULT_BOOKING_PARAMETERS);
    });
  });

  describe('AG-098 · cambiar un parámetro no toca lo ya reservado', () => {
    it('AG-098 no revalida ni anula la cita reservada bajo el valor anterior', async () => {
      const created = await book(aSlotAt(at(future, '08:00'))).expect(201);
      const id = (created.body as { id: string }).id;
      const before = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id },
      });

      // La sede se vuelve mucho más restrictiva: con un día de antelación
      // máxima, esa misma cita hoy no se podría pedir.
      await setParameters({ maxLeadDays: 1 });

      // La fila entera, columna por columna: ni el estado, ni el instante, ni
      // la anulación, ni la liberación se movieron.
      const after = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id },
      });
      expect(after).toEqual(before);

      // Y sigue en la agenda operativa del día, que es donde recepción la ve.
      const day = await request(app.getHttpServer())
        .get(`/api/v1/agenda/sites/${siteId}/entries?date=${future}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (day.body as { items: { id: string }[] }).items.map((i) => i.id),
      ).toEqual([id]);

      // El valor nuevo rige para lo siguiente, que es la otra mitad: si no
      // rigiera, la prueba pasaría con el parámetro ignorado por completo.
      const refused = await book(aSlotAt(at(future, '08:20'))).expect(422);
      expect((refused.body as Problem).code).toBe('BOOKING_TOO_FAR');
    });
  });

  describe('AG-102 · la retención de anuladas no borra nada', () => {
    it('AG-102 anular saca la cita del listado operativo y no borra la entrada ni su historial', async () => {
      const created = await book(aSlotAt(at(future, '08:00'))).expect(201);
      const id = (created.body as { id: string }).id;

      await request(app.getHttpServer())
        .post(`/api/v1/agenda/sites/${siteId}/entries/${id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ to: 'CANCELLED', reason: 'La paciente reprograma' })
        .expect(200);

      const day = (query = '') =>
        request(app.getHttpServer())
          .get(`/api/v1/agenda/sites/${siteId}/entries?date=${future}${query}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      // «Deja de verse»: fuera del listado operativo…
      expect((await day()).body).toMatchObject({ items: [] });
      // …y NO «deja de existir»: se sigue pudiendo pedir, y la fila está.
      const asked = (await day('&includeReleased=true')).body as {
        items: { id: string }[];
      };
      expect(asked.items.map((item) => item.id)).toEqual([id]);

      const stored = await prisma.agendaEntry.findUniqueOrThrow({
        where: { id },
      });
      expect(stored.status).toBe('CANCELLED');
      // Ni borrada ni anonimizada: el paciente, el motivo de la anulación y el
      // profesional siguen ahí. Es prueba médico-legal (D-004).
      expect(stored.patientId).toBe(patientId);
      expect(stored.practitionerId).toBe(practitionerId);
      expect(stored.cancellationNote).toBe('La paciente reprograma');

      // Y el historial de estados, que es la respuesta a «¿por qué salió
      // anulada esta cita?», conserva la transición con su autor (AG-004).
      const history = await prisma.agendaStatusHistory.findMany({
        where: { agendaEntryId: id },
      });
      expect(history).not.toHaveLength(0);
      expect(history.at(-1)).toMatchObject({
        toStatus: 'CANCELLED',
        fromStatus: 'BOOKED',
      });
    });

    it('AG-102 no admite hoy ninguna política de retención que purgue', async () => {
      // Mientras el plazo legal de conservación siga sin confirmarse (REQ-006),
      // «retención» solo puede significar «deja de verse». Un parámetro de días
      // que además borrara convertiría un descuido de configuración en pérdida
      // irreversible de prueba médico-legal, así que el tipo de la base no
      // ofrece ninguna otra opción: la garantía es el enum, no la disciplina.
      const labels = await prisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT enumlabel
          FROM pg_enum
          JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
         WHERE pg_type.typname = 'cancelled_retention_policy'
         ORDER BY enumlabel
      `;

      expect(labels.map((row) => row.enumlabel)).toEqual(['NEVER']);
    });
  });
});
