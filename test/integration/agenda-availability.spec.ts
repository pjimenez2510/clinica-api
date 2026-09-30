import type { PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { AgendaService } from '../../src/modules/agenda/application/agenda.service';
import { PrismaAgendaRepository } from '../../src/modules/agenda/infrastructure/prisma-agenda.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import {
  CLINIC_TIME_ZONE,
  WallClockTime,
  atWallClock,
  parseClinicalDate,
} from '../../src/shared/domain/clinic-time';
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
async function context(
  rule: { validFrom?: Date; validTo?: Date | null; slotAtom?: number } = {},
) {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  await linkPractitionerToSite(prisma, practitioner.id, site.id);
  // D-021: the grid is the site's. Twenty minutes is what every case here read
  // off the rule before the atom moved, so the expectations are unchanged.
  await setSlotAtom(prisma, site.id, rule.slotAtom ?? 20);

  const scheduleRule = await createScheduleRule(
    prisma,
    { practitionerId: practitioner.id, siteId: site.id },
    {
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
      validFrom: rule.validFrom ?? new Date('2026-01-01T00:00:00Z'),
      validTo: rule.validTo ?? null,
    },
  );

  return { prisma, site, practitioner, patient, scheduleRule };
}

const at = (isoUtc: string) => new Date(isoUtc);

describe('deriving availability against the database', () => {
  /**
   * D-021. La rejilla que la agenda deriva sale del ÁTOMO DE LA SEDE
   * (`site_parameter.slot_atom_minutes`), no de la regla, que ya no lleva
   * ninguno. Contra PostgreSQL de verdad porque es donde vive ese número, en
   * una tabla de otro módulo que la agenda lee por su puerto.
   */
  it('AG-094 deriva los cupos del turno de la sede y no de la regla', async () => {
    const { prisma, site, practitioner } = await context({ slotAtom: 30 });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    // 08:00–12:00 en cupos de treinta: ocho, y no los doce de veinte.
    expect(view.slots).toHaveLength(8);
    expect(view.slots.every((slot) => slot.slotMinutes === 30)).toBe(true);
    expect(view.slots[1]?.startsAt.toISOString()).toBe(
      '2026-09-14T13:30:00.000Z',
    );
  });

  it('AG-095 deriva con el turno por defecto del código cuando la sede no tiene fila', async () => {
    // La misma cadena que la ventana de reserva: sede → clínica → código. La
    // fila la escribe un disparador (CF-062), así que esto sólo pasa con un
    // volcado restaurado a medias — y entonces la agenda opera con diez.
    const { prisma, site, practitioner } = await context();
    await prisma.siteParameter.delete({ where: { siteId: site.id } });

    const view = await agendaOf(prisma).availability({
      siteId: site.id,
      practitionerId: practitioner.id,
      from: parseClinicalDate('2026-09-14'),
      to: parseClinicalDate('2026-09-14'),
    });

    expect(view.slots).toHaveLength(24);
    expect(view.slots.every((slot) => slot.slotMinutes === 10)).toBe(true);
  });

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
      const { prisma, site, practitioner, patient } = await context({
        slotAtom: 30,
      });
      // Wednesday rule, 20:00–21:00 on a 30-minute grid: two slots.
      await createScheduleRule(
        prisma,
        { practitionerId: practitioner.id, siteId: site.id },
        { weekday: 3, startTime: '20:00', endTime: '21:00' },
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
  /**
   * AG-144, contra la base porque la garantía que la rejilla tiene que
   * respetar ES el `EXCLUDE`: `agenda_entry_no_practitioner_overlap` compara
   * el profesional y el intervalo, no la sede. Un profesional con horario en
   * dos sedes a la misma hora —lo que la semilla de desarrollo hace— tiene UN
   * solo calendario.
   */
  describe('AG-144 practitioner who also works at another site', () => {
    // The derivation reads no clock: any Monday proves it, and this is the one
    // every other case of the file uses.
    const MONDAY = parseClinicalDate('2026-09-14'); // fecha-fija: la disponibilidad no lee el reloj; el lunes del resto del archivo
    const monday = (hhmm: string) =>
      atWallClock(MONDAY, WallClockTime.parse(hhmm), CLINIC_TIME_ZONE);
    const day = { from: MONDAY, to: MONDAY };

    async function twoSites() {
      const base = await context();
      const { prisma, practitioner } = base;
      const other = await createSite(prisma, 'Sede Norte');
      await linkPractitionerToSite(prisma, practitioner.id, other.id);
      await setSlotAtom(prisma, other.id, 20);
      await createScheduleRule(
        prisma,
        { practitionerId: practitioner.id, siteId: other.id },
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
      );
      return { ...base, other };
    }

    it('AG-144 does not offer the slot the practitioner holds at another site, and offers the next one', async () => {
      const { prisma, site, other, practitioner, patient } = await twoSites();

      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: other.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: monday('08:00'),
          endsAt: monday('08:20'),
        },
      });

      // The premise, proved against the database: the same hour at THIS site
      // is exactly what the EXCLUDE refuses.
      const second = await createPatient(prisma);
      await expect(
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            siteId: site.id,
            practitionerId: practitioner.id,
            patientId: second.id,
            startsAt: monday('08:00'),
            endsAt: monday('08:20'),
          },
        }),
      ).rejects.toThrow(/agenda_entry_no_practitioner_overlap/);

      const view = await agendaOf(prisma).availability({
        siteId: site.id,
        practitionerId: practitioner.id,
        ...day,
      });

      const starts = view.slots.map((slot) => slot.startsAt.getTime());
      expect(starts).not.toContain(monday('08:00').getTime());
      // Positive control: the rest of the morning is still on offer.
      expect(starts).toContain(monday('08:20').getTime());
      expect(view.slots).toHaveLength(11);
      // The other site's entry is not this site's to show (AG-107).
      expect(view.occupied).toEqual([]);
    });

    it('AG-144 offers at the other site only what is left of a day filled at one site (the 43 of 48 of 30-09-2026)', async () => {
      // The development data of 30-09-2026: the walks of every session had
      // filled 43 of the 48 slots of medico@ at Sede Norte, and Sede Sur still
      // offered all 48. Same shape here: a day of two shifts on a ten-minute
      // atom at both sites, 43 slots taken at one of them.
      const { prisma, site, other, practitioner, patient } = await twoSites();
      for (const siteId of [site.id, other.id]) {
        await setSlotAtom(prisma, siteId, 10);
        await createScheduleRule(
          prisma,
          { practitionerId: practitioner.id, siteId },
          { weekday: 1, startTime: '14:00', endTime: '18:00' },
        );
      }

      const request = (siteId: string) =>
        agendaOf(prisma).availability({
          siteId,
          practitionerId: practitioner.id,
          ...day,
        });

      const grid = (await request(other.id)).slots;
      expect(grid).toHaveLength(48);
      const taken = grid.slice(0, 43);
      for (const slot of taken) {
        await prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            status: 'CHECKED_IN',
            siteId: other.id,
            practitionerId: practitioner.id,
            patientId: patient.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          },
        });
      }

      const here = await request(site.id);
      const there = await request(other.id);

      // Control: where the appointments are, five are left.
      expect(there.slots).toHaveLength(5);
      // And here, the same five — not forty-eight.
      expect(here.slots.map((slot) => slot.startsAt)).toEqual(
        there.slots.map((slot) => slot.startsAt),
      );
      expect(here.occupied).toEqual([]);
    });

    it('AG-144 gives back the slot when the entry at the other site is released, like the EXCLUDE', async () => {
      const { prisma, site, other, practitioner, patient } = await twoSites();

      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          status: 'CANCELLED',
          siteId: other.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: monday('08:00'),
          endsAt: monday('08:20'),
          releasedAt: monday('07:00'),
        },
      });

      const view = await agendaOf(prisma).availability({
        siteId: site.id,
        practitionerId: practitioner.id,
        ...day,
      });

      expect(view.slots).toHaveLength(12);
      expect(view.slots[0]?.startsAt).toEqual(monday('08:00'));
    });

    it('AG-144 subtracts a block the practitioner holds at another site', async () => {
      const { prisma, site, other, practitioner } = await twoSites();

      await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          status: 'BLOCKED',
          siteId: other.id,
          practitionerId: practitioner.id,
          startsAt: monday('10:00'),
          endsAt: monday('12:00'),
        },
      });

      const view = await agendaOf(prisma).availability({
        siteId: site.id,
        practitionerId: practitioner.id,
        ...day,
      });

      expect(view.slots).toHaveLength(6);
      expect(view.slots.at(-1)?.startsAt).toEqual(monday('09:40'));
    });
  });
});
