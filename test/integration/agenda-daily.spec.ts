import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { describe, expect, inject, it } from 'vitest';

import { AgendaService } from '../../src/modules/agenda/application/agenda.service';
import {
  BookingRetryExhaustedError,
  SlotNotAlignedError,
} from '../../src/modules/agenda/domain/agenda.errors';
import { PrismaAgendaRepository } from '../../src/modules/agenda/infrastructure/prisma-agenda.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { isSerialisationFailure } from '../../src/shared/infrastructure/prisma/serialisation-retry';

import { parseClinicalDate } from '../../src/shared/domain/clinic-time';
import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createRoom,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';

/**
 * The day's agenda, against a real PostgreSQL.
 *
 * WHY NOT A UNIT TEST WITH A DOUBLE. What is being verified here is where the
 * day begins and ends and which rows the database actually returns for it —
 * a double would hand back whatever it was given and prove neither. The
 * Ecuadorian boundary is the whole point: an appointment at 20:30 local is
 * 01:30Z the NEXT day, and a query cut in UTC loses it from the day it
 * happens.
 */
const db = useDatabase();

/** Enough of PinoLogger for the adapter, without booting NestJS. */
const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

function agendaOf(prisma: PrismaClient): {
  service: AgendaService;
  repository: PrismaAgendaRepository;
} {
  const repository = new PrismaAgendaRepository(
    prisma as unknown as PrismaService,
    logger,
  );
  return { repository, service: new AgendaService(repository, logger) };
}

async function context() {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  return { prisma, site, practitioner, patient };
}

/** An appointment, written straight through Prisma: the listing is what is under test. */
async function anAppointment(
  prisma: PrismaClient,
  data: {
    siteId: string;
    practitionerId: string;
    patientId: string;
    roomId?: string;
    startsAt: Date;
    endsAt: Date;
    releasedAt?: Date;
    status?: 'BOOKED' | 'CANCELLED';
  },
) {
  return prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'PHONE',
      ...data,
    },
  });
}

/**
 * A block of several days, written straight through Prisma.
 *
 * It has NO patient and NO booking channel — `agenda_entry_patient_coherence`
 * and `agenda_entry_booking_channel_coherence` refuse both on a `BLOCK` — and
 * it is a SINGLE row whose `starts_at` is the first day of the absence.
 */
async function aBlock(
  prisma: PrismaClient,
  data: {
    siteId: string;
    practitionerId: string;
    startsAt: Date;
    endsAt: Date;
  },
) {
  return prisma.agendaEntry.create({
    data: { kind: 'BLOCK', status: 'BLOCKED', ...data },
  });
}

/** 14 September 2026 is a Monday. Ecuador is UTC-5 and does not move. */
const DAY = parseClinicalDate('2026-09-14');
const at = (isoUtc: string) => new Date(isoUtc);

describe('the daily agenda', () => {
  it('AG-017 lists the site day resolved in America/Guayaquil, not in UTC', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const { service } = agendaOf(prisma);

    // 08:00 Ecuador on the 14th.
    const morning = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startsAt: at('2026-09-14T13:00:00Z'),
      endsAt: at('2026-09-14T14:00:00Z'),
    });

    // 20:30 Ecuador on the 14th — which is 01:30Z on the FIFTEENTH. A day cut
    // in UTC would file it under the 15th and the evening shift would not find
    // its own appointments.
    const evening = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: (await createPatient(prisma)).id,
      startsAt: at('2026-09-15T01:30:00Z'),
      endsAt: at('2026-09-15T02:00:00Z'),
    });

    // 23:00 Ecuador on the THIRTEENTH — 04:00Z on the 14th. The mirror image:
    // a UTC day would drag it in.
    await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: (await createPatient(prisma)).id,
      startsAt: at('2026-09-14T04:00:00Z'),
      endsAt: at('2026-09-14T04:30:00Z'),
    });

    const listed = await service.dailyAgenda({ siteId: site.id, date: DAY });

    // Ordered by start instant, and only the two that happen on the 14th in
    // Ecuador.
    expect(listed.map((entry) => entry.id)).toEqual([morning.id, evening.id]);
  });

  it('AG-017 leaves out the entries of another site', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const otherSite = await createSite(prisma, 'Sede Sur');
    const { service } = agendaOf(prisma);

    await anAppointment(prisma, {
      siteId: otherSite.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startsAt: at('2026-09-14T13:00:00Z'),
      endsAt: at('2026-09-14T14:00:00Z'),
    });

    await expect(
      service.dailyAgenda({ siteId: site.id, date: DAY }),
    ).resolves.toEqual([]);
  });

  it('AG-017 narrows the day to one practitioner or one room', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const other = await createPractitioner(prisma);
    const room = await createRoom(prisma, site.id);
    const { service } = agendaOf(prisma);

    const mine = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      roomId: room.id,
      startsAt: at('2026-09-14T13:00:00Z'),
      endsAt: at('2026-09-14T14:00:00Z'),
    });
    await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: other.id,
      patientId: (await createPatient(prisma)).id,
      startsAt: at('2026-09-14T15:00:00Z'),
      endsAt: at('2026-09-14T16:00:00Z'),
    });

    await expect(
      service
        .dailyAgenda({
          siteId: site.id,
          date: DAY,
          practitionerId: practitioner.id,
        })
        .then((rows) => rows.map((r) => r.id)),
    ).resolves.toEqual([mine.id]);

    await expect(
      service
        .dailyAgenda({ siteId: site.id, date: DAY, roomId: room.id })
        .then((rows) => rows.map((r) => r.id)),
    ).resolves.toEqual([mine.id]);
  });

  it('AG-018 hides released entries, and flags them when they are asked for', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const { service } = agendaOf(prisma);

    const live = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startsAt: at('2026-09-14T13:00:00Z'),
      endsAt: at('2026-09-14T14:00:00Z'),
    });

    // Cancelled at 09:00: the slot went back to the pool, and the row stays.
    const released = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: (await createPatient(prisma)).id,
      startsAt: at('2026-09-14T15:00:00Z'),
      endsAt: at('2026-09-14T16:00:00Z'),
      releasedAt: at('2026-09-14T14:00:00Z'),
      status: 'CANCELLED',
    });

    const byDefault = await service.dailyAgenda({ siteId: site.id, date: DAY });
    expect(byDefault.map((entry) => entry.id)).toEqual([live.id]);

    const everything = await service.dailyAgenda({
      siteId: site.id,
      date: DAY,
      includeReleased: true,
    });
    expect(everything.map((entry) => entry.id)).toEqual([live.id, released.id]);
    // "Señalar cuáles lo están": the instant is what tells them apart, and it
    // is present on both rows rather than only on one.
    expect(everything.map((entry) => entry.releasedAt)).toEqual([
      null,
      released.releasedAt,
    ]);
  });

  it('AG-017 lists a multi-day block on a day it does not start on', async () => {
    // Una semana de vacaciones es UNA fila cuyo `starts_at` es el lunes.
    // Filtrando por `starts_at` dentro del día, el miércoles sale vacío en el
    // listado mientras la disponibilidad da el día por ocupado: dos rutas del
    // mismo módulo contradiciéndose sobre el mismo día, y la que ve recepción
    // es la que miente (AG-011).
    const { prisma, site, practitioner } = await context();
    const { service } = agendaOf(prisma);

    const leave = await aBlock(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      // Del lunes 14 a las 00:00 al sábado 19 a las 00:00, hora de Ecuador.
      startsAt: at('2026-09-14T05:00:00Z'),
      endsAt: at('2026-09-19T05:00:00Z'),
    });

    const middleDay = await service.dailyAgenda({
      siteId: site.id,
      date: parseClinicalDate('2026-09-16'),
    });

    expect(middleDay.map((entry) => entry.id)).toEqual([leave.id]);

    // Y no se cuela en un día que el bloqueo no toca: `ends_at` es exclusivo,
    // igual que el `tstzrange(…, '[)')` de los EXCLUDE.
    await expect(
      service.dailyAgenda({
        siteId: site.id,
        date: parseClinicalDate('2026-09-19'),
      }),
    ).resolves.toEqual([]);
  });

  it('AG-072 no carga el motivo de consulta de las filas del día', async () => {
    // Lo que no se carga no puede filtrarse. Es lo que ya hace la ruta de
    // disponibilidad, y el listado lo traía en el `select` bajo un comentario
    // que afirmaba lo contrario.
    const { prisma, site, practitioner, patient } = await context();
    const { service } = agendaOf(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        reason: 'Control de embarazo',
        startsAt: at('2026-09-14T13:00:00Z'),
        endsAt: at('2026-09-14T14:00:00Z'),
      },
    });

    const listed = await service.dailyAgenda({ siteId: site.id, date: DAY });

    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!)).not.toContain('reason');
    expect(JSON.stringify(listed)).not.toContain('Control de embarazo');
  });

  it('AG-072 writes no chart access while listing the day', async () => {
    // SC-004: listing generates ZERO rows in the access trail. Opening a chart
    // generates exactly one, and that happens in the patient register.
    const { prisma, site, practitioner, patient } = await context();
    const { service } = agendaOf(prisma);

    await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startsAt: at('2026-09-14T13:00:00Z'),
      endsAt: at('2026-09-14T14:00:00Z'),
    });

    await service.dailyAgenda({ siteId: site.id, date: DAY });

    await expect(prisma.accessAudit.count()).resolves.toBe(0);
  });
});

/**
 * A meeting point for two transactions that have to interleave.
 *
 * Without it each transaction reads AND commits before the other starts, and
 * PostgreSQL has nothing to serialise: the test would pass with no conflict
 * ever produced, which is the failure mode of every concurrency test that
 * "works".
 */
function barrier(parties: number): { arrive: () => Promise<void> } {
  let waiting = 0;
  let release: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    arrive: () => {
      waiting += 1;
      if (waiting >= parties) release();
      return opened;
    },
  };
}

/**
 * Makes PostgreSQL actually raise `40001`, and hands the error back.
 *
 * WRITE SKEW UNDER `SERIALIZABLE`: both transactions read the same predicate
 * over `agenda_entry` and then each inserts a row that the other's read would
 * have matched. Neither insert conflicts with the other — different hours, so
 * no EXCLUDE fires — and the two reads-then-writes form the dependency cycle
 * that serialisable isolation refuses at commit time.
 *
 * The point is not that our code produces this; it is that the SHAPE of the
 * error our retry recognises is the shape PostgreSQL 18 and this driver
 * actually deliver. A hand-written fake would prove only that we can write
 * a fake.
 */
async function provokeSerialisationFailure(ids: {
  siteId: string;
  practitionerId: string;
  firstPatientId: string;
  secondPatientId: string;
}): Promise<Error> {
  const url = inject('databaseUrl');
  const clients = [
    new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
  ];

  const read = barrier(2);
  const written = barrier(2);

  const attempt = (client: PrismaClient, patientId: string, hour: number) =>
    client.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT count(*) FROM agenda_entry WHERE site_id = ${ids.siteId}::uuid
        `;
        await read.arrive();

        await tx.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            siteId: ids.siteId,
            practitionerId: ids.practitionerId,
            patientId,
            startsAt: new Date(Date.UTC(2026, 8, 14, hour, 0)),
            endsAt: new Date(Date.UTC(2026, 8, 14, hour + 1, 0)),
          },
        });
        await written.arrive();
      },
      { isolationLevel: 'Serializable', timeout: 20_000, maxWait: 20_000 },
    );

  try {
    const outcomes = await Promise.allSettled([
      attempt(clients[0]!, ids.firstPatientId, 8),
      attempt(clients[1]!, ids.secondPatientId, 10),
    ]);

    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    // Neither transaction failing means the interleaving did not happen and
    // the test below would assert nothing at all.
    if (!rejected) {
      throw new Error('PostgreSQL serialised both transactions without conflict'); // prettier-ignore
    }
    return rejected.reason as Error;
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
}

describe('AG-026 a booking aborted for serialisation', () => {
  it('AG-026 recognises the serialisation failure PostgreSQL really raises', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const second = await createPatient(prisma);

    const failure = await provokeSerialisationFailure({
      siteId: site.id,
      practitionerId: practitioner.id,
      firstPatientId: patient.id,
      secondPatientId: second.id,
    });

    // Exactly one of the two was aborted, and it is the one our retry has to
    // recognise. If this ever stops holding — a driver upgrade changing where
    // the SQLSTATE lands — the retry would silently stop retrying, and the
    // symptom would be receptionists told "try again" for taken slots.
    expect(failure).toBeDefined();
    expect(isSerialisationFailure(failure)).toBe(true);

    // And the honest half: exactly one row survived.
    await expect(prisma.agendaEntry.count()).resolves.toBe(1);
  });

  it('AG-026 answers a retryable 503 with a wait, never a slot conflict', async () => {
    const { prisma, site, practitioner, patient } = await context();
    const second = await createPatient(prisma);

    // The REAL error captured above, replayed on every attempt: a database
    // that never stops aborting is the case the requirement is about, and it
    // cannot be produced on demand against a live server.
    const failure = await provokeSerialisationFailure({
      siteId: site.id,
      practitionerId: practitioner.id,
      firstPatientId: patient.id,
      secondPatientId: second.id,
    });

    let attempts = 0;
    const alwaysAborting = {
      agendaEntry: {
        create: () => {
          attempts += 1;
          return Promise.reject(failure);
        },
      },
    } as unknown as PrismaService;

    const repository = new PrismaAgendaRepository(alwaysAborting, logger);

    const rejection = await repository
      .book({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: new Date('2026-09-14T13:00:00Z'),
        endsAt: new Date('2026-09-14T13:20:00Z'),
        bookingChannel: 'PHONE',
        createdById: '00000000-0000-4000-8000-000000000009',
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BookingRetryExhaustedError);
    const error = rejection as BookingRetryExhaustedError;

    // It RETRIED before giving up, and gave up at the budget.
    expect(attempts).toBe(3);

    // 503 with a wait, not 409: `isRetryable` is what the problem filter maps
    // to Service Unavailable, and `retryAfterSeconds` becomes `Retry-After`.
    // Answering `PRACTITIONER_SLOT_TAKEN` here would move a patient's
    // appointment for a slot nobody has taken.
    expect(error.code).toBe('BOOKING_RETRY_EXHAUSTED');
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });
});

/**
 * Which schedule rule governs a booking when a practitioner's schedule is
 * REPLACED: the old rule closed, the new one in force from the next day.
 *
 * IT USED TO BE «two rules in force over the same hours — a state nothing in
 * the schema forbids today». ST-042 forbids it since 13-08-2026: the EXCLUDE
 * `schedule_rule_no_overlap` refuses two rules in force for the same
 * practitioner, site and weekday over overlapping hours, so the old scenario
 * is no longer representable. What AG-106 protects is the same and still
 * needs a real PostgreSQL: the defect was the ABSENCE of an ORDER BY, and a
 * double hands back the array it was given.
 */
describe('the applicable schedule rule', () => {
  /**
   * D-021 CHANGED WHAT DISTINGUISHES THE TWO RULES. It used to be their slot
   * length, and the grid is the site's now. What is left is where each rule's
   * grid BEGINS (AG-104): a rule opening at 08:00 puts a boundary at 08:20 and
   * none at 08:10; one opening at 08:10 does the opposite. So which rule
   * governs still decides whether a booking is accepted — which is why the
   * criterion has to be written down rather than left to PostgreSQL's row
   * order.
   */
  async function withTwoOverlappingRules(newerStartTime: '08:00' | '08:10') {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    await linkPractitionerToSite(prisma, practitioner.id, site.id);

    // Se insertan SIEMPRE en el mismo orden físico — 20 primero — y sólo
    // cambia cuál entró en vigor después. Si el orden de la consulta no fuese
    // explícito, las dos pruebas darían el mismo resultado.
    //
    // La regla vieja lleva `validTo`: desde ST-042 dos reglas vigentes no
    // pueden solaparse, así que una sustitución se escribe como sucesión —
    // último día de la vieja, primer día de la nueva—, que es exactamente lo
    // que ST-041 llama cerrar hacia adelante.
    const olderStartTime = newerStartTime === '08:00' ? '08:10' : '08:00';
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      {
        weekday: 1,
        startTime: olderStartTime,
        endTime: '12:00',
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validTo: new Date('2026-05-31T00:00:00Z'),
      },
    );
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      {
        weekday: 1,
        startTime: newerStartTime,
        endTime: '12:00',
        validFrom: new Date('2026-06-01T00:00:00Z'),
      },
    );

    // AG-031, desde E7: la sede admite reservar en el pasado. Las citas de
    // este fichero viven en un lunes fijo —lo exigen las dos reglas que se
    // suceden en fechas concretas—, y un lunes fijo deja de ser futuro en
    // cuanto el calendario lo pasa. Sin esto, AG-106 empezaría a fallar por
    // una razón que no tiene nada que ver con qué regla gobierna el cupo.
    await prisma.siteParameter.update({
      where: { siteId: site.id },
      // D-021: veinte minutos, que es la rejilla con la que se escribieron
      // estos casos. La sede nace con diez (D-021), y aquí importa que 08:10
      // NO sea borde de la regla que abre a las 08:00.
      data: { allowPastBooking: true, slotAtomMinutes: 20 },
    });

    return { prisma, site, practitioner, patient };
  }

  /** 08:10–08:30 en Ecuador: un cupo entero, y sólo desde la regla de 08:10. */
  const tenPast = {
    startsAt: new Date('2026-09-14T13:10:00Z'),
    endsAt: new Date('2026-09-14T13:30:00Z'),
    bookingChannel: 'PHONE',
  };

  it('AG-106 aplica la regla que entró en vigor más tarde, y no la que devuelva primero PostgreSQL', async () => {
    const { prisma, site, practitioner, patient } =
      await withTwoOverlappingRules('08:10');
    const { service } = agendaOf(prisma);

    const { entry } = await service.book(
      {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...tenPast,
      },
      { userId: (await prisma.user.findFirstOrThrow()).id },
    );

    expect(entry.startsAt).toEqual(tenPast.startsAt);
  });

  it('AG-106 rechaza bajo la regla más reciente lo que la anterior admitía', async () => {
    const { prisma, site, practitioner, patient } =
      await withTwoOverlappingRules('08:00');
    const { service } = agendaOf(prisma);

    const rejection = await service
      .book(
        {
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...tenPast,
        },
        { userId: (await prisma.user.findFirstOrThrow()).id },
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(SlotNotAlignedError);
    await expect(prisma.agendaEntry.count()).resolves.toBe(0);
  });
});
