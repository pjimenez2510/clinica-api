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
} from './setup/fixtures';

/**
 * Availability against a real PostgreSQL.
 *
 * WHY NOT A DOUBLE. What the domain suite proves is the subtraction; what only
 * a database can prove is that the rows the adapter asks for are the rows the
 * subtraction needs — the validity window read off `date` columns, the
 * occupancy read off `timestamptz` ones, and the two agreeing about which day
 * it is in Ecuador. A double hands back whatever it was given and proves
 * neither half.
 *
 * 14 and 21 September 2026 are Mondays; 15 September is a Tuesday. Ecuador is
 * UTC-5, so 08:00 there is 13:00Z.
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

/** A practitioner who takes appointments at a site, with a Monday rule. */
async function context(rule: { validFrom?: Date; validTo?: Date | null } = {}) {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  await linkPractitionerToSite(prisma, practitioner.id, site.id);

  const scheduleRule = await createScheduleRule(
    prisma,
    { practitionerId: practitioner.id, siteId: site.id },
    {
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
      slotMinutes: 20,
      validFrom: rule.validFrom ?? new Date('2026-01-01T00:00:00Z'),
      validTo: rule.validTo ?? null,
    },
  );

  return { prisma, site, practitioner, patient, scheduleRule };
}

const at = (isoUtc: string) => new Date(isoUtc);

describe('deriving availability against the database', () => {
  it('AG-010 offers slots only on the dates the rule in force covers', async () => {
    // Valid until Monday the 14th, inclusive. The 21st is also a Monday and it
    // is past the window.
    const { prisma, site, practitioner } = await context({
      validTo: new Date('2026-09-14T00:00:00Z'),
    });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-21'),
    });

    expect(view.slots).toHaveLength(12);
    expect(
      view.slots.every((slot) =>
        slot.startsAt.toISOString().startsWith('2026-09-14'),
      ),
    ).toBe(true);
    // The day bounds are Ecuadorian: the first slot is 08:00 there, 13:00Z.
    expect(view.slots[0]?.startsAt.toISOString()).toBe(
      '2026-09-14T13:00:00.000Z',
    );
  });

  it('AG-011 keeps showing an appointment booked under a rule that is no longer in force', async () => {
    // The rule expired on Sunday the 13th; the appointment it produced is on
    // Monday the 14th and the patient will turn up for it.
    const { prisma, site, practitioner, patient } = await context({
      validTo: new Date('2026-09-13T00:00:00Z'),
    });

    const booked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: at('2026-09-14T13:00:00Z'),
        endsAt: at('2026-09-14T13:20:00Z'),
      },
    });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    // No slot: the rule that would produce them is gone.
    expect(view.slots).toEqual([]);
    // And the appointment is still there. Filtering the entries by the rules
    // would erase it from the screen and from nowhere else.
    expect(view.occupied.map((entry) => entry.id)).toEqual([booked.id]);
  });

  it('AG-011 lists an entry booked under an expired rule alongside the slots of the rule that replaced it', async () => {
    const { prisma, site, practitioner, patient } = await context({
      validTo: new Date('2026-09-13T00:00:00Z'),
    });

    // The new rule starts later in the morning: 10:00–12:00, six slots.
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      {
        weekday: 1,
        startTime: '10:00',
        endTime: '12:00',
        slotMinutes: 20,
        validFrom: new Date('2026-09-14T00:00:00Z'),
      },
    );

    // An 08:00 appointment booked while the old rule was still in force.
    const booked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: at('2026-09-14T13:00:00Z'),
        endsAt: at('2026-09-14T13:20:00Z'),
      },
    });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    expect(view.slots).toHaveLength(6);
    expect(view.slots[0]?.startsAt.toISOString()).toBe(
      '2026-09-14T15:00:00.000Z',
    );
    expect(view.occupied.map((entry) => entry.id)).toEqual([booked.id]);
  });

  it('AG-003 subtracts a block that began before the range and runs through it', async () => {
    const { prisma, site, practitioner } = await context();

    // A week of leave, from Friday the 11th to Friday the 18th. It starts
    // outside the range asked for and occupies every day of it: a query that
    // only asked for entries STARTING inside the range would offer the whole
    // Monday of somebody who is away.
    await prisma.agendaEntry.create({
      data: {
        kind: 'BLOCK',
        status: 'BLOCKED',
        siteId: site.id,
        practitionerId: practitioner.id,
        startsAt: at('2026-09-11T13:00:00Z'),
        endsAt: at('2026-09-18T22:00:00Z'),
      },
    });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    expect(view.slots).toEqual([]);
    expect(view.occupied).toHaveLength(1);
  });

  it('AG-003 offers again a slot whose appointment was released', async () => {
    const { prisma, site, practitioner, patient } = await context();

    // Cancelled: the row survives and the slot goes back to the pool. That is
    // the predicate of both EXCLUDE constraints, and the reason a cancelled
    // appointment must not keep the hour blocked.
    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        status: 'CANCELLED',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startsAt: at('2026-09-14T13:00:00Z'),
        endsAt: at('2026-09-14T13:20:00Z'),
        releasedAt: at('2026-09-13T13:00:00Z'),
      },
    });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    expect(view.slots).toHaveLength(12);
    expect(view.occupied).toEqual([]);
  });

  it('AG-001 resolves the range in America/Guayaquil while the host clock is in Tokyo', async () => {
    // Node re-reads `process.env.TZ`. Wednesday 12 August 2026 in Ecuador runs
    // from 05:00Z to 05:00Z on the 13th; in Tokyo it began fourteen hours
    // earlier. A range cut with the host's clock would file the 20:30
    // appointment under the next day and offer its hour as free.
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';

    try {
      const { prisma, site, practitioner, patient } = await context();
      // Wednesday rule, 20:00–21:00 in slots of thirty: two slots.
      await createScheduleRule(
        prisma,
        { practitionerId: practitioner.id, siteId: site.id },
        { weekday: 3, startTime: '20:00', endTime: '21:00', slotMinutes: 30 },
      );

      // 20:30 in Ecuador on the 12th, which is 01:30Z on the THIRTEENTH.
      const evening = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: at('2026-08-13T01:30:00Z'),
          endsAt: at('2026-08-13T02:00:00Z'),
        },
      });

      const view = await agendaOf(prisma).availability({
        siteId: site.id,
        practitionerId: practitioner.id,
        from: parseClinicalDate('2026-08-12'),
        to: parseClinicalDate('2026-08-12'),
      });

      // The day ends where Ecuador says: the 20:30 appointment belongs to the
      // 12th and its slot is not on offer.
      expect(view.occupied.map((entry) => entry.id)).toEqual([evening.id]);
      expect(view.slots.map((slot) => slot.startsAt.toISOString())).toEqual([
        '2026-08-13T01:00:00.000Z',
      ]);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
