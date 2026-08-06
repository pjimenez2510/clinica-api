import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describe, expect, inject, it } from 'vitest';

import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createRoom,
  createSite,
  hourSlot,
} from './setup/fixtures';

/**
 * The appointment non-overlap rule.
 *
 * This is enforced by two EXCLUDE constraints backed by GiST indexes, not by
 * application code — deliberately, because a check in TypeScript loses to a
 * race: two receptionists booking the same slot in the same millisecond both
 * read "free" and both write. Only the database can decide.
 *
 * Which is exactly why it has to be tested HERE. A unit test with a mocked
 * repository would return whatever we programmed and prove nothing at all.
 */
describe('agenda entry overlap', () => {
  const db = useDatabase();

  async function scheduleContext() {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    return { prisma, site, practitioner, patient };
  }

  it('books an appointment when the slot is free', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const entry = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    expect(entry.id).toBeTruthy();
  });

  it('REFUSES a second appointment overlapping the same practitioner', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const other = await createPatient(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    // Starts half an hour into the previous appointment.
    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: other.id,
          startsAt: new Date(Date.UTC(2026, 8, 14, 9, 30)),
          endsAt: new Date(Date.UTC(2026, 8, 14, 10, 30)),
        },
      }),
    ).rejects.toThrow(/agenda_entry_no_practitioner_overlap/);
  });

  it('allows an appointment that starts exactly when the previous one ends', async () => {
    // The range is half-open `[)`: 09:00–10:00 and 10:00–11:00 do NOT overlap.
    // Were it closed, the whole agenda would lose one slot per hour to a
    // boundary that does not exist in reality.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const contiguous = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(10),
      },
    });

    expect(contiguous.id).toBeTruthy();
  });

  it('frees the slot once the appointment is released', async () => {
    // `released_at` is what makes cancelling actually free the time. Without
    // this the constraint would keep blocking a slot nobody occupies.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const first = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    await prisma.agendaEntry.update({
      where: { id: first.id },
      data: { releasedAt: new Date(), status: 'CANCELLED' },
    });

    const rebooked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(9),
      },
    });

    expect(rebooked.id).toBeTruthy();
  });

  it('REFUSES two appointments in the same room at the same time', async () => {
    const { prisma, site, patient } = await scheduleContext();
    const room = await createRoom(prisma, site.id);
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: first.id,
        roomId: room.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    // A different practitioner — the practitioner rule does not apply. Only
    // the room rule stands between two patients and the same physical door.
    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: second.id,
          roomId: room.id,
          patientId: (await createPatient(prisma)).id,
          ...hourSlot(9),
        },
      }),
    ).rejects.toThrow(/agenda_entry_no_room_overlap/);
  });

  it('lets a non-blocking entry coexist with an appointment', async () => {
    // Overbooking: a slot marked as not blocking the calendar is exempt from
    // the constraint by its own predicate.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const overbooked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        blocksCalendar: false,
        ...hourSlot(9),
      },
    });

    expect(overbooked.id).toBeTruthy();
  });

  it('REFUSES an entry that ends before it starts', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date(Date.UTC(2026, 8, 14, 10, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 14, 9, 0)),
        },
      }),
    ).rejects.toThrow(/agenda_entry_time_order/);
  });

  it('REFUSES an appointment with no patient, and a block with one', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          ...hourSlot(9),
        },
      }),
    ).rejects.toThrow(/agenda_entry_patient_coherence/);

    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(11),
        },
      }),
    ).rejects.toThrow(/agenda_entry_patient_coherence/);
  });

  it('ARBITRATES between two receptionists booking the same slot', async () => {
    /**
     * The reason this rule lives in the database and not in a service.
     *
     * Every comment in this codebase justifies the EXCLUDE with "two
     * receptionists booking in the same millisecond", and until now nothing
     * exercised it: the other tests write one row and then another, which
     * proves uniqueness, not arbitration. A `SELECT ... WHERE NOT EXISTS`
     * followed by an INSERT would pass all of them and still double-book,
     * because both transactions read "free" before either writes.
     *
     * Two independent clients, so these are genuinely two connections. Both
     * insert before either commits — which is the moment that matters.
     */
    const { site, practitioner, patient } = await scheduleContext();
    const other = await createPatient(db());
    const url = inject('databaseUrl');

    const clientA = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const clientB = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });

    const slot = hourSlot(16);

    const book = (client: PrismaClient, patientId: string) =>
      client.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId,
          ...slot,
        },
      });

    try {
      // No barrier holding the transactions open, and the first attempt at one
      // taught us why: PostgreSQL makes the second writer WAIT on the first
      // one's uncommitted row and only rejects it at that commit. Trying to
      // force both to insert before either commits deadlocks by construction —
      // that blocking IS the arbitration.
      const outcomes = await Promise.allSettled([
        book(clientA, patient.id),
        book(clientB, other.id),
      ]);

      // EXACTLY one, not "at least one failed": two winners is the bug.
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

      // And the loser gets an answer she can act on, not a server error.
      const loser = outcomes.find((o) => o.status === 'rejected');
      expect(extractDatabaseProblem(loser?.reason)?.code).toBe(
        'PRACTITIONER_SLOT_TAKEN',
      );
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });

  it('blocks the calendar for a vacation block just like an appointment', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await prisma.agendaEntry.create({
      data: {
        kind: 'BLOCK',
        siteId: site.id,
        practitionerId: practitioner.id,
        reason: 'Vacaciones',
        ...hourSlot(9),
      },
    });

    await expect(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(9),
        },
      }),
    ).rejects.toThrow(/agenda_entry_no_practitioner_overlap/);
  });
});
