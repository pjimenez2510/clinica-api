import { PrismaPg } from '@prisma/adapter-pg';
import { type AgendaEntry, PrismaClient } from '@prisma/client';
import { describe, expect, inject, it } from 'vitest';

import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/agenda/infrastructure/agenda.constraints';
import { withSerialisationRetry } from '../../src/shared/infrastructure/prisma/serialisation-retry';

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
 * This is enforced by three EXCLUDE constraints backed by GiST indexes, not by
 * application code — deliberately, because a check in TypeScript loses to a
 * race: two receptionists booking the same slot in the same millisecond both
 * read "free" and both write. Only the database can decide.
 *
 * Which is exactly why it has to be tested HERE. A unit test with a mocked
 * repository would return whatever we programmed and prove nothing at all.
 */
const db = useDatabase();

async function scheduleContext() {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  return { prisma, site, practitioner, patient };
}

/**
 * AG-035, AG-036 (E4). Las tres columnas de un sobrecupo, que viajan juntas o
 * no viajan: `agenda_entry_overbooking_coherence` no admite ninguna otra
 * combinación. El autorizador es una cuenta real porque la clave foránea lo
 * exige — y aquí basta con que EXISTA: qué permisos tiene lo comprueba el
 * servicio, no la base (AG-101).
 */
function anOverbooking(authorisedById: string) {
  return {
    blocksCalendar: false,
    overbookingReason: 'Urgencia',
    overbookingAuthorisedById: authorisedById,
  };
}

/**
 * The rejection itself, so the same failure can be asserted twice: which
 * constraint fired, and what the client is told about it.
 *
 * `rejects.toThrow(/constraint_name/)` only proves the first. A constraint
 * that answered 500 would still pass it, and that is precisely the bug
 * `database-problem.ts` exists to prevent — the requirements name a code and
 * a status, not a PostgreSQL message.
 */
async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the database was expected to reject this operation');
}

describe('agenda entry overlap', () => {
  it('books an appointment when the slot is free', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const entry = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    expect(entry.id).toBeTruthy();
  });

  it('AG-023 REFUSES a second appointment overlapping the same practitioner', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const other = await createPatient(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    // Starts half an hour into the previous appointment.
    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: other.id,
          startsAt: new Date(Date.UTC(2026, 8, 14, 9, 30)),
          endsAt: new Date(Date.UTC(2026, 8, 14, 10, 30)),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_no_practitioner_overlap/);

    // What the receptionist is actually told: a conflict she can act on, and
    // the field that caused it, never a server failure.
    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe('PRACTITIONER_SLOT_TAKEN');
    expect(problem?.errors).toEqual([
      {
        field: 'startsAt',
        code: 'PRACTITIONER_SLOT_TAKEN',
        message: 'El profesional ya tiene una cita en ese horario',
      },
    ]);
  });

  it('AG-023 ADMITS an appointment that starts exactly when the previous one ends', async () => {
    // The range is half-open `[)`: 09:00–10:00 and 10:00–11:00 do NOT overlap.
    // Were it closed, the whole agenda would lose one slot per hour to a
    // boundary that does not exist in reality.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const contiguous = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(10),
      },
    });

    expect(contiguous.id).toBeTruthy();
  });

  it('AG-023 frees the slot once the appointment is released', async () => {
    // `released_at` is what makes cancelling actually free the time. Without
    // this the constraint would keep blocking a slot nobody occupies.
    //
    // The overlap rule speaks of entries that OCCUPY THE CALENDAR, and a
    // released one does not: `released_at IS NULL` is half of the EXCLUDE
    // predicate. This is the same requirement seen from the side where it must
    // NOT fire.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const first = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
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
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(9),
      },
    });

    expect(rebooked.id).toBeTruthy();
  });

  it('AG-024 REFUSES two appointments in the same room at the same time', async () => {
    const { prisma, site, patient } = await scheduleContext();
    const room = await createRoom(prisma, site.id);
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: first.id,
        roomId: room.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    // A different practitioner — the practitioner rule does not apply. Only
    // the room rule stands between two patients and the same physical door.
    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: second.id,
          roomId: room.id,
          patientId: (await createPatient(prisma)).id,
          ...hourSlot(9),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_no_room_overlap/);

    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe('ROOM_SLOT_TAKEN');
    expect(problem?.errors?.[0]?.field).toBe('roomId');
  });

  it('AG-024 ADMITS the same time in a different room', async () => {
    // The room rule is keyed on the room, not on the hour. Without this, a
    // constraint accidentally written over `site_id` would pass every other
    // test in this file and halve the clinic's capacity.
    const { prisma, site, patient } = await scheduleContext();
    const room = await createRoom(prisma, site.id);
    const otherRoom = await createRoom(prisma, site.id);
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: first.id,
        roomId: room.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const parallel = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: second.id,
        roomId: otherRoom.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(9),
      },
    });

    expect(parallel.id).toBeTruthy();
  });

  it('AG-024 ADMITS two simultaneous entries with no room assigned', async () => {
    // The room EXCLUDE is partial: `room_id IS NOT NULL`. Sites that do not
    // manage consulting rooms leave it empty, and NULL is not "the same room" —
    // were the constraint total, every such site would be limited to one
    // appointment at a time across the whole clinic.
    const { prisma, site, patient } = await scheduleContext();
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: first.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const roomless = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: second.id,
        patientId: (await createPatient(prisma)).id,
        ...hourSlot(9),
      },
    });

    expect(roomless.roomId).toBeNull();
  });

  it('lets a non-blocking entry coexist with an appointment', async () => {
    // Overbooking: a slot marked as not blocking the calendar is exempt from
    // the constraint by its own predicate.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const overbooked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: (await createPatient(prisma)).id,
        // AG-035 desde E4: un sobrecupo no puede existir sin constancia.
        // `agenda_entry_overbooking_coherence` exige el motivo y el
        // autorizador exactamente cuando `blocks_calendar` es `false` — la
        // exención del `EXCLUDE` y la constancia son la misma decisión.
        ...anOverbooking(practitioner.userId),
        ...hourSlot(9),
      },
    });

    expect(overbooked.id).toBeTruthy();
  });

  it('AG-022 REFUSES an entry that ends before it starts', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: new Date(Date.UTC(2026, 8, 14, 10, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 14, 9, 0)),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_time_order/);

    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(422);
    expect(problem?.code).toBe('INVALID_TIME_RANGE');
    expect(problem?.errors?.[0]?.field).toBe('endsAt');
  });

  it('AG-022 REFUSES an entry that ends at the very instant it starts', async () => {
    // The requirement says the end must be LATER than the start, not merely
    // "not earlier". A zero-length appointment occupies no time, and the
    // half-open range `[)` makes it overlap nothing at all: it would sit in the
    // agenda invisible to the very rule that protects the slot.
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const instant = new Date(Date.UTC(2026, 8, 14, 10, 0));

    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: instant,
          endsAt: instant,
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_time_order/);
    expect(extractDatabaseProblem(rejection)?.code).toBe('INVALID_TIME_RANGE');
  });

  it('AG-021 REFUSES an appointment with no patient, and a block with one', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const withoutPatient = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          ...hourSlot(9),
        },
      }),
    );
    expect(withoutPatient.message).toMatch(/agenda_entry_patient_coherence/);

    const blockWithPatient = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(11),
        },
      }),
    );
    expect(blockWithPatient.message).toMatch(/agenda_entry_patient_coherence/);

    // Both halves of the CHECK reach the client as the same actionable answer.
    for (const rejection of [withoutPatient, blockWithPatient]) {
      const problem = extractDatabaseProblem(rejection);
      expect(problem?.status).toBe(422);
      expect(problem?.code).toBe('PATIENT_REQUIRED');
      expect(problem?.errors?.[0]?.field).toBe('patientId');
    }
  });

  it('AG-025 ARBITRATES between two receptionists booking the same slot', async () => {
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

    /**
     * A través del MISMO reintento que usa el repositorio.
     *
     * Antes esto llamaba a `create` directamente y por eso la aserción de
     * abajo tenía que admitir dos códigos: PostgreSQL resuelve la carrera o
     * haciendo esperar al perdedor y rechazándolo con 23P01, o abortándolo con
     * 40001, y eso depende del milisegundo. Con el reintento el 40001 se
     * vuelve a intentar, la fila ganadora ya está confirmada, y el perdedor
     * recibe siempre la respuesta honesta: ese cupo está ocupado.
     */
    const book = (client: PrismaClient, patientId: string) =>
      withSerialisationRetry(() =>
        client.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            siteId: site.id,
            practitionerId: practitioner.id,
            patientId,
            ...slot,
          },
        }),
      );

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
      const winners = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<AgendaEntry> =>
          outcome.status === 'fulfilled',
      );
      expect(winners).toHaveLength(1);

      /**
       * WHO won, and not merely how many.
       *
       * Which of the two clients wins is the database's call and cannot be
       * predicted, but the winner is knowable after the fact: it is the one
       * whose row is in the table. Asserting that the surviving row is exactly
       * the one the successful call returned — same id, same patient — is what
       * rules out the two failures a count would miss: a "winner" whose insert
       * was rolled back, and a loser who left a row behind anyway.
       */
      const held = await db().agendaEntry.findMany({
        where: {
          practitionerId: practitioner.id,
          startsAt: slot.startsAt,
          releasedAt: null,
          blocksCalendar: true,
        },
      });

      expect(held).toHaveLength(1);
      expect(held[0]?.id).toBe(winners[0]?.value.id);
      expect(held[0]?.patientId).toBe(winners[0]?.value.patientId);

      // And the loser's patient holds nothing: she was told to pick another
      // time, and the agenda agrees with what she was told.
      const loserPatientId =
        winners[0]?.value.patientId === patient.id ? other.id : patient.id;
      await expect(
        db().agendaEntry.count({ where: { patientId: loserPatientId } }),
      ).resolves.toBe(0);

      /**
       * The loser is told the slot is taken. ONE CODE, not two.
       *
       * This assertion used to admit `CONCURRENT_UPDATE` as well, and that was
       * honest at the time: PostgreSQL resolves the race either by making the
       * loser wait and rejecting it with 23P01, or by aborting it with 40001,
       * and which one happens depends on the millisecond. The two mean
       * opposite things to a receptionist — "pick another time" versus "try
       * again, it may well work" — so a client could not act on either.
       *
       * AG-026 removed the ambiguity: `withSerialisationRetry` retries the
       * 40001, by which point the winner's row is committed and the exclusion
       * constraint gives the honest answer. Loosening this back to two codes
       * would mean the retry stopped working.
       */
      const loser = outcomes.find((o) => o.status === 'rejected');
      const problem = extractDatabaseProblem(loser?.reason);
      expect(problem?.status).toBe(409);
      expect(problem?.code).toBe('PRACTITIONER_SLOT_TAKEN');
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });

  it('AG-023 REFUSES an appointment over a vacation block of the same practitioner', async () => {
    // A BLOCK occupies the calendar exactly like an appointment does: the
    // EXCLUDE predicate reads `blocks_calendar`, never `kind`. A doctor on
    // leave is unbookable, and nothing in the constraint has to know why.
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
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(9),
        },
      }),
    ).rejects.toThrow(/agenda_entry_no_practitioner_overlap/);
  });
});

/**
 * The patient side of the same guarantee.
 *
 * AG-023 and AG-024 keep a practitioner and a room from being in two places at
 * once. Neither says anything about the patient, who is one person and cannot
 * be in dermatology and traumatology at eleven o'clock. Until
 * `agenda_entry_no_patient_overlap` existed this was checked — if at all — in
 * the service, which is a read followed by a write and therefore a race.
 */
describe('agenda entry patient double booking', () => {
  it('AG-030 REFUSES a second appointment overlapping the same patient', async () => {
    // Two DIFFERENT practitioners on purpose: with the same one, the
    // practitioner EXCLUDE would fire first and this test would pass without
    // the patient constraint existing at all.
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const otherPractitioner = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'WALK_IN',
          siteId: site.id,
          practitionerId: otherPractitioner.id,
          patientId: patient.id,
          startsAt: new Date(Date.UTC(2026, 8, 14, 9, 30)),
          endsAt: new Date(Date.UTC(2026, 8, 14, 10, 30)),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_no_patient_overlap/);

    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe('PATIENT_DOUBLE_BOOKED');
    expect(problem?.errors).toEqual([
      {
        field: 'patientId',
        code: 'PATIENT_DOUBLE_BOOKED',
        message:
          'El paciente ya tiene otra cita a esa hora: elija otro horario o anule la anterior',
      },
    ]);
  });

  it('AG-030 ADMITS two different patients at the same hour', async () => {
    // The constraint is keyed on the patient. One written over `site_id`, or
    // one that forgot the `patient_id WITH =` operator altogether, would still
    // pass every rejection test in this file and would let the clinic see a
    // single patient per hour.
    const { prisma, site, patient } = await scheduleContext();
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);
    const otherPatient = await createPatient(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: first.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const parallel = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: second.id,
        patientId: otherPatient.id,
        ...hourSlot(9),
      },
    });

    expect(parallel.id).toBeTruthy();
  });

  it('AG-030 ADMITS an overbooked entry for a patient who already has an appointment', async () => {
    // Same exemption as the other two EXCLUDEs: `blocks_calendar = false` is
    // the documented way to break the rule, and it leaves a record of having
    // done so. A patient squeezed in for an urgent second opinion is exactly
    // that case.
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const otherPractitioner = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const overbooked = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'WALK_IN',
        siteId: site.id,
        practitionerId: otherPractitioner.id,
        patientId: patient.id,
        // AG-035: la exención del `EXCLUDE` va con su constancia (E4).
        ...anOverbooking(otherPractitioner.userId),
        ...hourSlot(9),
      },
    });

    expect(overbooked.id).toBeTruthy();
  });

  it('AG-030 ADMITS booking the patient again once the first appointment is released', async () => {
    // A cancelled or no-show appointment stops occupying the calendar, so it
    // stops standing in the way of rebooking the same patient at that hour.
    const { prisma, site, practitioner, patient } = await scheduleContext();
    const otherPractitioner = await createPractitioner(prisma);

    const first = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
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
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: otherPractitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    expect(rebooked.id).toBeTruthy();
  });

  it('AG-030 ARBITRATES between two receptionists booking the same patient at the same hour', async () => {
    /**
     * Same reasoning as AG-025, on the constraint that did not exist until
     * now. Two receptionists at two desks, each booking the same patient with
     * a DIFFERENT practitioner for eleven o'clock: nothing in the practitioner
     * or room rules applies, so only the patient EXCLUDE can arbitrate. A
     * service-level check would have both transactions read "the patient is
     * free" and both write.
     */
    const { site, practitioner, patient } = await scheduleContext();
    const otherPractitioner = await createPractitioner(db());
    const url = inject('databaseUrl');

    const clientA = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const clientB = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });

    const slot = hourSlot(11);

    // Through the same retry as its neighbour, and for the same reason.
    const book = (client: PrismaClient, practitionerId: string) =>
      withSerialisationRetry(() =>
        client.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            siteId: site.id,
            practitionerId,
            patientId: patient.id,
            ...slot,
          },
        }),
      );

    try {
      const outcomes = await Promise.allSettled([
        book(clientA, practitioner.id),
        book(clientB, otherPractitioner.id),
      ]);

      // EXACTLY one, not "at least one failed": two winners is the bug.
      const winners = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<AgendaEntry> =>
          outcome.status === 'fulfilled',
      );
      expect(winners).toHaveLength(1);

      // WHO won: the row that survived is the one the successful call
      // returned, same id and same practitioner. A count alone would miss both
      // a rolled-back winner and a loser that left a row behind.
      const held = await db().agendaEntry.findMany({
        where: {
          patientId: patient.id,
          startsAt: slot.startsAt,
          releasedAt: null,
          blocksCalendar: true,
        },
      });

      expect(held).toHaveLength(1);
      expect(held[0]?.id).toBe(winners[0]?.value.id);
      expect(held[0]?.practitionerId).toBe(winners[0]?.value.practitionerId);

      // The losing practitioner's agenda is empty: nothing was reserved
      // against a doctor whose receptionist was told no.
      const loserPractitionerId =
        winners[0]?.value.practitionerId === practitioner.id
          ? otherPractitioner.id
          : practitioner.id;
      await expect(
        db().agendaEntry.count({
          where: { practitionerId: loserPractitionerId },
        }),
      ).resolves.toBe(0);

      // One code, exactly as in AG-025: the 40001 is retried, so what reaches
      // the loser is the constraint's own answer and never the transient one.
      const loser = outcomes.find((o) => o.status === 'rejected');
      const problem = extractDatabaseProblem(loser?.reason);
      expect(problem?.status).toBe(409);
      expect(problem?.code).toBe('PATIENT_DOUBLE_BOOKED');
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });
});

/**
 * Coherence between what an entry IS and what it can be.
 *
 * `agenda_entry_patient_coherence` already ties `kind` to `patient_id`. These
 * two CHECKs tie it to `status` and to `booking_channel`, which were free to
 * contradict it: an APPOINTMENT sitting in BLOCKED, and an appointment with no
 * booking channel at all while a room closure claimed to have been booked by
 * telephone.
 */
describe('agenda entry kind coherence', () => {
  it('AG-046 REFUSES an appointment in BLOCKED status', async () => {
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          status: 'BLOCKED',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(9),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_kind_status_coherence/);

    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(422);
    expect(problem?.code).toBe('INVALID_STATUS_FOR_KIND');
    expect(problem?.errors).toEqual([
      {
        field: 'status',
        code: 'INVALID_STATUS_FOR_KIND',
        message:
          'Ese estado no corresponde al tipo de entrada: «bloqueado» es solo para un bloqueo de agenda',
      },
    ]);
  });

  it('AG-046 ADMITS a block in BLOCKED status', async () => {
    // The other direction of the same rule. A CHECK written as
    // `status <> 'BLOCKED'` would pass the test above and make the only status
    // a block is meant to hold unreachable.
    const { prisma, site, practitioner } = await scheduleContext();

    const block = await prisma.agendaEntry.create({
      data: {
        kind: 'BLOCK',
        status: 'BLOCKED',
        siteId: site.id,
        practitionerId: practitioner.id,
        reason: 'Quirófano',
        ...hourSlot(9),
      },
    });

    expect(block.status).toBe('BLOCKED');
  });

  it('AG-046 REFUSES a block in a status that only a patient can reach', async () => {
    // CHECKED_IN means somebody arrived, and AG-021 guarantees a block has no
    // patient. The same goes for CONFIRMED, IN_PROGRESS, FULFILLED and
    // NO_SHOW: a block is created, possibly BLOCKED, and eventually cancelled.
    const { prisma, site, practitioner } = await scheduleContext();

    const rejection = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          status: 'CHECKED_IN',
          siteId: site.id,
          practitionerId: practitioner.id,
          reason: 'Reunión',
          ...hourSlot(9),
        },
      }),
    );

    expect(rejection.message).toMatch(/agenda_entry_kind_status_coherence/);
    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'INVALID_STATUS_FOR_KIND',
    );
  });

  it('AG-034 REFUSES a booking channel outside the four admitted values', async () => {
    // Raw SQL because the point is the DATABASE, not the Prisma type: the
    // column used to be VARCHAR(32), where 'telefono' and 'Phone' were as
    // valid as PHONE and split AG-080's no-show metric into spelling variants.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const rejection = await rejectionOf(
      prisma.$executeRaw`
        INSERT INTO agenda_entry
          (kind, site_id, practitioner_id, patient_id, starts_at, ends_at, booking_channel)
        VALUES
          ('APPOINTMENT', ${site.id}::uuid, ${practitioner.id}::uuid,
           ${patient.id}::uuid, '2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z',
           'telefono'::booking_channel)
      `,
    );

    expect(rejection.message).toMatch(/invalid input value for enum/);

    // No constraint name to read here — PostgreSQL rejects the cast before any
    // constraint runs — so this is the SQLSTATE fallback for malformed input.
    // The requirement's own code, INVALID_BOOKING_CHANNEL, is produced by the
    // DTO, which is where a client's typo belongs; the database is the second
    // line, and it answers 422 rather than 500.
    const problem = extractDatabaseProblem(rejection);
    expect(problem?.status).toBe(422);
    expect(problem?.code).toBe('INVALID_FORMAT');
  });

  it('AG-034 ADMITS each of the four booking channels', async () => {
    const { prisma, site, practitioner } = await scheduleContext();
    const channels = ['PHONE', 'WALK_IN', 'WEB', 'REFERRAL'] as const;

    const created = await Promise.all(
      channels.map(async (channel, index) =>
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: channel,
            siteId: site.id,
            practitionerId: practitioner.id,
            patientId: (await createPatient(prisma)).id,
            ...hourSlot(8 + index * 2),
          },
        }),
      ),
    );

    expect(created.map((entry) => entry.bookingChannel)).toEqual([...channels]);
  });

  it('AG-034 REQUIRES a channel on an appointment and REFUSES one on a block', async () => {
    // AG-029: "CUANDO se reserve una cita, el sistema DEBERÁ registrar el canal
    // de reserva". A nullable column made that a hope. A block is not booked
    // by anyone, so the other half of the CHECK keeps the field from being
    // filled with noise that AG-080 would then group by.
    const { prisma, site, practitioner, patient } = await scheduleContext();

    const withoutChannel = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(9),
        },
      }),
    );
    expect(withoutChannel.message).toMatch(
      /agenda_entry_booking_channel_coherence/,
    );

    const blockWithChannel = await rejectionOf(
      prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: practitioner.id,
          reason: 'Vacaciones',
          ...hourSlot(11),
        },
      }),
    );
    expect(blockWithChannel.message).toMatch(
      /agenda_entry_booking_channel_coherence/,
    );

    for (const rejection of [withoutChannel, blockWithChannel]) {
      const problem = extractDatabaseProblem(rejection);
      expect(problem?.status).toBe(422);
      expect(problem?.code).toBe('BOOKING_CHANNEL_REQUIRED');
      expect(problem?.errors?.[0]?.field).toBe('bookingChannel');
    }
  });
});
