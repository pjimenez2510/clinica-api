import type { PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { AgendaService } from '../../src/modules/agenda/application/agenda.service';
import { PrismaAgendaRepository } from '../../src/modules/agenda/infrastructure/prisma-agenda.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { parseClinicalDate } from '../../src/shared/domain/clinic-time';
import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
  setSlotAtom,
} from './setup/fixtures';

/**
 * Holidays in the availability query, against a real PostgreSQL.
 *
 * WHY NOT A DOUBLE. The domain suite proves who observes which holiday; what
 * only a database can prove is that the rows the adapter asks for are the rows
 * that reasoning needs — `holiday.date` is a `date` column and not an instant,
 * the scope is a NULLABLE foreign key, and the AG-092 exception lives in a
 * second table. A double hands back whatever it was given and proves none of
 * the three.
 *
 * 14 and 21 September 2026 are Mondays; 25 December 2026 is a Friday. Ecuador
 * is UTC-5, so 08:00 there is 13:00Z.
 */
const db = useDatabase();

/** Enough of PinoLogger for the adapter, without booting NestJS. */
const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

function agendaOf(prisma: PrismaClient): AgendaService {
  return new AgendaService(
    new PrismaAgendaRepository(prisma as unknown as PrismaService, logger),
    logger,
  );
}

/**
 * Two sites, one practitioner who works at both, and the same Monday morning
 * at each.
 *
 * TWO SITES FROM THE START, because every requirement in this file is about
 * who a holiday reaches: with one site, «aplica sólo a las sedes indicadas»
 * and «aplica a todas» are indistinguishable and the tests would pass with the
 * scope ignored entirely.
 */
async function twoSites(weekday = 1) {
  const prisma = db();
  const north = await createSite(prisma, 'Sede Norte');
  const south = await createSite(prisma, 'Sede Sur');
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);

  for (const site of [north, south]) {
    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    // D-021: la rejilla es de la sede. Veinte minutos es lo que este fichero
    // leía de la regla antes de que el átomo subiera; la sede nace con diez.
    await setSlotAtom(prisma, site.id, 20);
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday, startTime: '08:00', endTime: '12:00' },
    );
  }

  return { prisma, north, south, practitioner, patient };
}

/**
 * A row of `holiday`, written as the calendar day it is.
 *
 * The `Z` is not decoration: a `date` column round-trips as UTC midnight, and
 * building the value with the host's zone would file «25 de diciembre» as the
 * 24th for everybody west of Greenwich, which is everybody here.
 */
async function declareHoliday(
  prisma: PrismaClient,
  holiday: { date: string; name: string; siteId?: string | null },
) {
  return prisma.holiday.create({
    data: {
      date: new Date(`${holiday.date}T00:00:00.000Z`),
      name: holiday.name,
      // `null` is the national scope: every site observes it (AG-091).
      siteId: holiday.siteId ?? null,
    },
  });
}

/** AG-092. This site WORKS that holiday: A&E opens on 25 December. */
async function siteWorksHoliday(
  prisma: PrismaClient,
  holidayId: string,
  siteId: string,
) {
  return prisma.holidaySiteException.create({ data: { holidayId, siteId } });
}

const availabilityOn = (
  prisma: PrismaClient,
  ids: { siteId: string; practitionerId: string },
  date: string,
) =>
  agendaOf(prisma).availability({
    siteId: ids.siteId,
    practitionerId: ids.practitionerId,
    from: parseClinicalDate(date),
    to: parseClinicalDate(date),
  });

describe('holidays in the availability query', () => {
  it('AG-090 resolves the holiday from the catalogue and never computes one', async () => {
    // Friday rule, so the date under test is Christmas itself.
    const { prisma, north, practitioner } = await twoSites(5);
    // A row elsewhere in the year, so 2026 counts as loaded and the answer
    // below is about the catalogue rather than about AG-093.
    await declareHoliday(prisma, { date: '2026-11-02', name: 'Difuntos' });

    const ids = { siteId: north.id, practitionerId: practitioner.id };

    // 25 December is a holiday in Ecuador by law and the system does not know
    // it: nothing here computes a calendar, and that is the requirement. A
    // formula would also be wrong the year the Executive moves the date.
    const before = await availabilityOn(prisma, ids, '2026-12-25');
    expect(before.slots).toHaveLength(12);
    expect(before.closedDates).toEqual([]);

    // The administrator loads it. Same query, different answer, no deploy.
    await declareHoliday(prisma, { date: '2026-12-25', name: 'Navidad' });

    const after = await availabilityOn(prisma, ids, '2026-12-25');
    expect(after.slots).toEqual([]);
    expect(after.closedDates).toEqual([
      { date: '2026-12-25', reason: 'Navidad' },
    ]);
  });

  it('AG-091 closes every site with a holiday of national scope', async () => {
    const { prisma, north, south, practitioner } = await twoSites();
    await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Feriado nacional',
      siteId: null,
    });

    for (const site of [north, south]) {
      const view = await availabilityOn(
        prisma,
        { siteId: site.id, practitionerId: practitioner.id },
        '2026-09-14',
      );

      expect(view.slots).toEqual([]);
      // AG-015: the motive travels, or the screen blames the doctor's diary.
      expect(view.closedDates).toEqual([
        { date: '2026-09-14', reason: 'Feriado nacional' },
      ]);
    }
  });

  it('AG-016 closes only the site that declared its own local holiday', async () => {
    const { prisma, north, south, practitioner } = await twoSites();
    await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Fundación de la ciudad',
      siteId: south.id,
    });

    const closed = await availabilityOn(
      prisma,
      { siteId: south.id, practitionerId: practitioner.id },
      '2026-09-14',
    );
    expect(closed.slots).toEqual([]);
    expect(closed.closedDates).toEqual([
      { date: '2026-09-14', reason: 'Fundación de la ciudad' },
    ]);

    // The other site works that Monday as usual, and is not even told why the
    // neighbour is shut.
    const open = await availabilityOn(
      prisma,
      { siteId: north.id, practitionerId: practitioner.id },
      '2026-09-14',
    );
    expect(open.slots).toHaveLength(12);
    expect(open.closedDates).toEqual([]);
  });

  it('AG-092 keeps the slots of a site that works a national holiday', async () => {
    const { prisma, north, south, practitioner } = await twoSites();
    const national = await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Feriado nacional',
    });
    // Urgencias abre: the exception is for the north site only.
    await siteWorksHoliday(prisma, national.id, north.id);

    const working = await availabilityOn(
      prisma,
      { siteId: north.id, practitionerId: practitioner.id },
      '2026-09-14',
    );
    expect(working.slots).toHaveLength(12);
    expect(working.closedDates).toEqual([]);

    // And the holiday keeps applying everywhere else, which is the whole
    // reason the exception is a row and not a deletion.
    const shut = await availabilityOn(
      prisma,
      { siteId: south.id, practitionerId: practitioner.id },
      '2026-09-14',
    );
    expect(shut.slots).toEqual([]);
    expect(shut.closedDates).toHaveLength(1);
  });

  it('AG-093 offers the slots of a year with no calendar loaded and warns about it', async () => {
    const { prisma, north, practitioner } = await twoSites();

    const view = await availabilityOn(
      prisma,
      { siteId: north.id, practitionerId: practitioner.id },
      '2026-09-14',
    );

    // The morning is offered: an empty catalogue is not a reason to shut the
    // agenda down.
    expect(view.slots).toHaveLength(12);
    expect(view.closedDates).toEqual([]);
    // And nothing claims the year has no holidays.
    expect(view.yearsWithoutCalendar).toEqual([2026]);
  });

  it('AG-093 stops warning once the year has a holiday loaded, whatever the date asked for', async () => {
    const { prisma, north, practitioner } = await twoSites();
    // A December row answers for the whole year: the warning is about the
    // calendar being loaded, not about this Monday having a holiday.
    await declareHoliday(prisma, { date: '2026-12-25', name: 'Navidad' });

    const view = await availabilityOn(
      prisma,
      { siteId: north.id, practitionerId: practitioner.id },
      '2026-09-14',
    );

    expect(view.slots).toHaveLength(12);
    expect(view.yearsWithoutCalendar).toEqual([]);
  });

  it('AG-015 marks the day closed and keeps the appointments already booked on it', async () => {
    const { prisma, north, practitioner, patient } = await twoSites();
    // Booked in advance; the holiday is declared afterwards, which is the
    // ordinary order of events when the Executive moves a date.
    const booked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: north.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: new Date('2026-09-14T13:00:00Z'),
        endsAt: new Date('2026-09-14T13:20:00Z'),
      },
    });
    await declareHoliday(prisma, { date: '2026-09-14', name: 'Navidad' });

    const view = await availabilityOn(
      prisma,
      { siteId: north.id, practitionerId: practitioner.id },
      '2026-09-14',
    );

    expect(view.slots).toEqual([]);
    // The appointment survives the day closing, for the same reason as AG-011:
    // nobody un-booked it and the patient will turn up.
    expect(view.occupied.map((entry) => entry.id)).toEqual([booked.id]);
  });

  /**
   * AG-110. Booking on a closed day, against the real catalogue.
   *
   * WHY IT IS HERE AND NOT ONLY IN THE DOMAIN SUITE. The pure functions prove
   * WHO observes which holiday; what only a database can prove is that the
   * booking path reads the same rows the availability query does — the scope
   * is a nullable foreign key, the AG-092 exception is a second table, and
   * `holiday.date` is a civil day rather than an instant. A double hands back
   * whatever it was given and proves none of the three, which is exactly the
   * drift D-019 was written about.
   *
   * 08:00 in Ecuador is 13:00Z, and the rule of `twoSites` covers Mondays.
   */
  const bookMondayMorning = async (
    prisma: PrismaClient,
    ids: { siteId: string; practitionerId: string; patientId: string },
  ) =>
    agendaOf(prisma).book(
      {
        ...ids,
        startsAt: new Date('2026-09-14T13:00:00Z'),
        endsAt: new Date('2026-09-14T13:20:00Z'),
        bookingChannel: 'PHONE',
      },
      { userId: (await prisma.user.findFirstOrThrow()).id },
    );

  it('AG-110 books on a holiday and warns with the reason instead of refusing', async () => {
    const { prisma, north, practitioner, patient } = await twoSites();
    await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Feriado nacional',
    });

    const { entry, warnings } = await bookMondayMorning(prisma, {
      siteId: north.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    // The appointment IS in the agenda: the warning describes a stored row,
    // not a refusal dressed up as advice.
    await expect(
      prisma.agendaEntry.findUnique({ where: { id: entry.id } }),
    ).resolves.toMatchObject({ siteId: north.id, status: 'BOOKED' });
    expect(warnings).toHaveLength(1);
    // The motive travels, and it is the same one the grid showed for the day.
    expect(warnings[0]).toContain('Feriado nacional');
  });

  it('AG-110 says nothing about a booking on an ordinary working day', async () => {
    const { prisma, north, practitioner, patient } = await twoSites();
    // A row elsewhere in the year, so the silence is about this Monday being
    // open and not about an empty catalogue.
    await declareHoliday(prisma, { date: '2026-12-25', name: 'Navidad' });

    const { warnings } = await bookMondayMorning(prisma, {
      siteId: north.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    expect(warnings).toEqual([]);
  });

  it('AG-110 says nothing to the site that works that holiday, and warns the one that does not', async () => {
    const { prisma, north, south, practitioner, patient } = await twoSites();
    const national = await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Feriado nacional',
    });
    // AG-092. Urgencias opens at the north site, so booking there is ordinary
    // work and there is nothing to say about it.
    await siteWorksHoliday(prisma, national.id, north.id);

    const working = await bookMondayMorning(prisma, {
      siteId: north.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    expect(working.warnings).toEqual([]);

    // And the exception belongs to one site: the neighbour is still told, or
    // the row would amount to deleting the holiday for everybody.
    const shut = await agendaOf(prisma).book(
      {
        siteId: south.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        // Another hour of the same Monday: the patient cannot hold two
        // appointments over one interval (AG-030).
        startsAt: new Date('2026-09-14T14:00:00Z'),
        endsAt: new Date('2026-09-14T14:20:00Z'),
        bookingChannel: 'PHONE',
      },
      { userId: (await prisma.user.findFirstOrThrow()).id },
    );
    expect(shut.warnings).toHaveLength(1);
    expect(shut.warnings[0]).toContain('Feriado nacional');
  });

  it('AG-110 warns about the Ecuadorian day of the appointment, not the UTC one', async () => {
    // 20:30 in Ecuador on the holiday is 01:30Z the NEXT day. Read in UTC the
    // booking would look like the 15th and the closure would go unsaid — the
    // same arithmetic that misclassifies a neonate's age.
    const { prisma, north, practitioner, patient } = await twoSites();
    // Media hora de rejilla en esta sede: la cita de 20:30 a 21:00 dura un
    // cupo entero y empieza en un borde (19:00, 19:30, 20:00, 20:30).
    await setSlotAtom(prisma, north.id, 30);
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: north.id },
      { weekday: 1, startTime: '19:00', endTime: '21:00' },
    );
    await declareHoliday(prisma, {
      date: '2026-09-14',
      name: 'Feriado nacional',
    });

    const { warnings } = await agendaOf(prisma).book(
      {
        siteId: north.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: new Date('2026-09-15T01:30:00Z'),
        endsAt: new Date('2026-09-15T02:00:00Z'),
        bookingChannel: 'PHONE',
      },
      { userId: (await prisma.user.findFirstOrThrow()).id },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Feriado nacional');
  });

  it('AG-015 closes the Ecuadorian day of the holiday while the host clock is behind UTC', async () => {
    /**
     * `holiday.date` is a CIVIL DAY with no hour at all, and a `date` column
     * round-trips through the driver as MIDNIGHT UTC. Read with the host's
     * local getters instead of its UTC ones, that instant keeps its day only
     * east of Greenwich and loses one to the WEST of it:
     *
     *     TZ=Asia/Tokyo        new Date('2026-09-14T00:00:00Z').getDate() → 14
     *     TZ=America/Guayaquil new Date('2026-09-14T00:00:00Z').getDate() → 13
     *
     * So the zone that exercises the defect is a western one, and Ecuador —
     * UTC-5, the only zone this clinic ever runs in — is exactly it: the
     * agenda would shut the Sunday before while offering the holiday itself.
     * An eastern zone would let a `getDate()` adapter pass.
     *
     * MUTATING `process.env.TZ` IS SAFE HERE, and only because of two facts
     * that hold today: `vitest.integration.config.mts` sets
     * `fileParallelism: false`, so no other spec file is running in this
     * process while this one does, and nothing inside this file is declared
     * `.concurrent`. The `finally` puts the original back even if the body
     * throws. If either fact changes, this has to move to a child process
     * with its own environment.
     */
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Guayaquil';

    try {
      const { prisma, north, practitioner } = await twoSites();
      await declareHoliday(prisma, {
        date: '2026-09-14',
        name: 'Feriado nacional',
      });

      const ids = { siteId: north.id, practitionerId: practitioner.id };

      const holiday = await availabilityOn(prisma, ids, '2026-09-14');
      expect(holiday.slots).toEqual([]);
      expect(holiday.closedDates.map((closed) => closed.date)).toEqual([
        '2026-09-14',
      ]);

      // The Monday after is an ordinary working day, and stays one.
      const nextMonday = await availabilityOn(prisma, ids, '2026-09-21');
      expect(nextMonday.slots).toHaveLength(12);
      expect(nextMonday.closedDates).toEqual([]);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
