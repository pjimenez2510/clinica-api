import { describe, expect, it } from 'vitest';

import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  InvalidAgendaTransitionError,
} from '../domain/agenda.errors';
import type { StatusChange } from '../domain/agenda.repository';
import { PrismaAgendaRepository } from './prisma-agenda.repository';

/**
 * The transition transaction, against a double of the Prisma client.
 *
 * WHAT A DOUBLE CAN HONESTLY PROVE HERE — and it is not the transaction
 * itself, which `test/integration/agenda-transitions.spec.ts` exercises
 * against a real PostgreSQL. It is the ORDER AND SHAPE of the writes: that
 * the update is CONDITIONED on the status that was read, that a zero-row
 * update re-reads and refuses with the status somebody else left, and that
 * the history insert only ever happens after a successful update. Those are
 * decisions of this adapter, and an integration failure reports them from
 * three layers away.
 */

const ENTRY_ID = '00000000-0000-4000-8000-00000000000a';
const CREATED_ID = '00000000-0000-4000-8000-00000000000b';
const SITE = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000004';

const NOW = new Date('2026-01-05T13:30:00Z');

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    kind: 'APPOINTMENT',
    siteId: SITE,
    practitionerId: '00000000-0000-4000-8000-000000000002',
    roomId: null,
    patientId: '00000000-0000-4000-8000-000000000003',
    startsAt: new Date('2026-01-05T13:00:00Z'),
    endsAt: new Date('2026-01-05T13:20:00Z'),
    status: 'BOOKED',
    blocksCalendar: true,
    releasedAt: null,
    bookingChannel: 'PHONE',
    serviceTypeConceptId: null,
    createdById: USER,
    encounter: null,
    // AG-051: what `ENTRY_SELECT` reads of the reschedule chain. An empty list
    // is "nothing replaced this one", which the partial unique index makes the
    // only alternative to a single element.
    rescheduledFromId: null,
    rescheduledTo: [],
    ...overrides,
  };
}

/**
 * A Prisma double whose `$transaction` simply runs the callback: what is
 * verified is which calls the adapter makes INSIDE it, in which order and
 * with which arguments.
 */
function prismaDouble(options: {
  /** Answers for `findFirst`/`findUniqueOrThrow`, consumed in call order. */
  reads: (Record<string, unknown> | null)[];
  updatedCount?: number;
  /** AG-052: what the INSERT of the new entry throws, if it is to fail. */
  createFails?: Error;
}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let readIndex = 0;

  const nextRead = () => options.reads[readIndex++] ?? null;

  const tx = {
    agendaEntry: {
      findFirst: (args: Record<string, unknown>) => {
        calls.push({ method: 'entry.findFirst', args });
        return Promise.resolve(nextRead());
      },
      findUniqueOrThrow: (args: Record<string, unknown>) => {
        calls.push({ method: 'entry.findUniqueOrThrow', args });
        const row = nextRead();
        return row ? Promise.resolve(row) : Promise.reject(new Error('gone'));
      },
      updateMany: (args: Record<string, unknown>) => {
        calls.push({ method: 'entry.updateMany', args });
        return Promise.resolve({ count: options.updatedCount ?? 1 });
      },
      create: (args: Record<string, unknown>) => {
        calls.push({ method: 'entry.create', args });
        return options.createFails
          ? Promise.reject(options.createFails)
          : Promise.resolve(entryRow({ id: CREATED_ID }));
      },
    },
    agendaStatusHistory: {
      create: (args: Record<string, unknown>) => {
        calls.push({ method: 'history.create', args });
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  };

  const logger = { setContext: () => undefined };

  return {
    calls,
    repository: new PrismaAgendaRepository(prisma as never, logger as never),
  };
}

const COMMAND = { siteId: SITE, entryId: ENTRY_ID, changedById: USER };

const toCheckedIn = (): StatusChange => ({
  to: 'CHECKED_IN',
  effects: { checkedInAt: NOW },
});

describe('the transition transaction', () => {
  it('AG-004 writes the history row with both states and the author, after the update', async () => {
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow({ status: 'CHECKED_IN' })],
    });

    await repository.transition(COMMAND, () => ({
      to: 'CHECKED_IN',
      effects: { checkedInAt: NOW },
      historyNote: 'llegó puntual',
    }));

    expect(calls.map((call) => call.method)).toEqual([
      'entry.findFirst',
      'entry.updateMany',
      'history.create',
      'entry.findUniqueOrThrow',
    ]);
    expect(calls[2]?.args).toEqual({
      data: {
        agendaEntryId: ENTRY_ID,
        fromStatus: 'BOOKED',
        toStatus: 'CHECKED_IN',
        changedById: USER,
        note: 'llegó puntual',
      },
    });
  });

  it('AG-005 only ever INSERTS into the history: the double exposes nothing else to call', async () => {
    // Structural, and deliberately so: the tx double has no `update` or
    // `delete` on `agendaStatusHistory`, so a regression that tried either
    // would throw here before it ever reached a database.
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow({ status: 'CHECKED_IN' })],
    });

    await repository.transition(COMMAND, toCheckedIn);

    const historyCalls = calls.filter((call) =>
      call.method.startsWith('history.'),
    );
    expect(historyCalls.map((call) => call.method)).toEqual(['history.create']);
  });

  it('AG-040 conditions the update on the status it read, so a racing writer makes it match zero rows', async () => {
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow({ status: 'CHECKED_IN' })],
    });

    await repository.transition(COMMAND, toCheckedIn);

    expect(calls[1]?.args).toMatchObject({
      where: { id: ENTRY_ID, siteId: SITE, status: 'BOOKED' },
      data: { status: 'CHECKED_IN', checkedInAt: NOW },
    });
  });

  it('AG-040 refuses a lost race with the status the winner left, and writes no history', async () => {
    const { repository, calls } = prismaDouble({
      // First read says BOOKED; the conditional update matches nothing; the
      // re-read finds what the winner committed meanwhile.
      reads: [entryRow(), { status: 'CHECKED_IN' }],
      updatedCount: 0,
    });

    const rejection = await repository
      .transition(COMMAND, toCheckedIn)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(InvalidAgendaTransitionError);
    expect((rejection as InvalidAgendaTransitionError).params).toEqual({
      from: 'CHECKED_IN',
      to: 'CHECKED_IN',
    });
    expect(calls.map((call) => call.method)).not.toContain('history.create');
  });

  it('AG-044 lands the cancellation note on the entry only when the policy set one', async () => {
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow({ status: 'CANCELLED' })],
    });

    await repository.transition(COMMAND, () => ({
      to: 'CANCELLED',
      effects: { cancelledAt: NOW, releasedAt: NOW },
      cancellationNote: 'Paciente reagenda',
      historyNote: 'Paciente reagenda',
    }));

    expect(calls[1]?.args).toMatchObject({
      data: {
        status: 'CANCELLED',
        cancelledAt: NOW,
        releasedAt: NOW,
        cancellationNote: 'Paciente reagenda',
      },
    });
  });

  it('AG-071 answers not-found for an unknown entry and writes nothing at all', async () => {
    const { repository, calls } = prismaDouble({ reads: [null] });

    await expect(
      repository.transition(COMMAND, toCheckedIn),
    ).rejects.toBeInstanceOf(AgendaEntryNotFoundError);

    expect(calls.map((call) => call.method)).toEqual(['entry.findFirst']);
    // The read itself is scoped by id AND site: an entry of another site is
    // indistinguishable from a missing one from the very first query.
    expect(calls[0]?.args).toMatchObject({
      where: { id: ENTRY_ID, siteId: SITE },
    });
  });

  it('AG-045 re-arbitrates the releasing update on releasedAt and encounter, not only on status', async () => {
    // Everything the closure decided on rides in the WHERE (adversarial
    // review of E2, P1/P2-1): an encounter committed between read and write
    // must make the update match zero rows, and a released row must never be
    // re-released with a later instant.
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow()],
    });

    await repository.transition(COMMAND, () => ({
      to: 'CANCELLED',
      effects: { cancelledAt: NOW, releasedAt: NOW },
      cancellationNote: 'paciente reagenda',
    }));

    expect(calls[1]?.args).toMatchObject({
      where: {
        id: ENTRY_ID,
        siteId: SITE,
        status: 'BOOKED',
        releasedAt: null,
        encounter: { is: null },
      },
    });
  });

  it('AG-045 blames the encounter, not the status, when the lost race was an attention', async () => {
    // The re-read finds the same status but a fresh encounter: telling the
    // receptionist to retry would ask her to do what AG-045 forbids.
    const { repository } = prismaDouble({
      reads: [entryRow(), entryRow({ encounter: { id: 'enc-1' } })],
      updatedCount: 0,
    });

    const rejection = await repository
      .transition(COMMAND, () => ({
        to: 'CANCELLED',
        effects: { cancelledAt: NOW, releasedAt: NOW },
      }))
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AgendaEntryHasEncounterError);
  });
});

/**
 * The reschedule transaction, against the same double.
 *
 * WHAT ONLY THIS FILE CAN PIN: the SHAPE — that the release and the insert are
 * issued inside ONE `$transaction`, in that order, and that the original is
 * re-read only after the insert so its forward link exists. Whether PostgreSQL
 * really rolls the release back when the insert is refused is not a claim a
 * double may make, and `test/integration/agenda-reschedule.spec.ts` makes it
 * against a real database.
 */
const NEW_SLOT = {
  startsAt: new Date('2026-01-05T14:00:00Z'),
  endsAt: new Date('2026-01-05T14:20:00Z'),
  bookingChannel: 'PHONE' as const,
};

const annul = (): StatusChange => ({
  to: 'CANCELLED',
  effects: { cancelledAt: NOW, releasedAt: NOW },
  cancellationNote: 'Paciente pide otra hora',
  historyNote: 'Paciente pide otra hora',
});

describe('the reschedule transaction', () => {
  it('AG-050 releases the existing row and INSERTS the new interval instead of updating it', async () => {
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow(), entryRow({ status: 'CANCELLED' })],
    });

    await repository.reschedule(COMMAND, NEW_SLOT, annul);

    expect(calls.map((call) => call.method)).toEqual([
      'entry.findFirst',
      'entry.updateMany',
      'history.create',
      // The columns the new row copies from the old one, read inside the
      // transaction so nothing about the appointment can change under it.
      'entry.findUniqueOrThrow',
      'entry.create',
      // Re-read AFTER the insert: before it, the original would come back
      // pointing at nothing (AG-051).
      'entry.findUniqueOrThrow',
    ]);

    // AG-050 in the one place it could be broken: the UPDATE stamps the
    // annulment and NEVER the new interval.
    expect(calls[1]?.args).toMatchObject({
      where: { id: ENTRY_ID, siteId: SITE, status: 'BOOKED', releasedAt: null },
      data: { status: 'CANCELLED', releasedAt: NOW },
    });
    const updateData = (calls[1]?.args as { data: Record<string, unknown> })
      .data;
    expect(updateData).not.toHaveProperty('startsAt');
    expect(updateData).not.toHaveProperty('endsAt');
  });

  it('AG-051 stamps the new entry with the entry it came from', async () => {
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow(), entryRow({ status: 'CANCELLED' })],
    });

    await repository.reschedule(COMMAND, NEW_SLOT, annul);

    const created = calls.find((call) => call.method === 'entry.create');
    expect(created?.args).toMatchObject({
      data: {
        kind: 'APPOINTMENT',
        siteId: SITE,
        startsAt: NEW_SLOT.startsAt,
        endsAt: NEW_SLOT.endsAt,
        bookingChannel: 'PHONE',
        createdById: USER,
        rescheduledFromId: ENTRY_ID,
      },
    });
  });

  it('AG-052 lets the refusal of the new entry escape, so the transaction takes the release with it', async () => {
    const slotTaken = new Error('exclusion violation');
    const { repository, calls } = prismaDouble({
      reads: [entryRow(), entryRow()],
      createFails: slotTaken,
    });

    await expect(repository.reschedule(COMMAND, NEW_SLOT, annul)).rejects.toBe(
      slotTaken,
    );

    // NOTHING is swallowed and nothing is compensated by hand: the adapter
    // does not catch this, so `$transaction` rolls the release back. A version
    // that answered "created: null" would leave the original annulled.
    expect(calls.map((call) => call.method)).toEqual([
      'entry.findFirst',
      'entry.updateMany',
      'history.create',
      'entry.findUniqueOrThrow',
      'entry.create',
    ]);
  });

  it('AG-052 writes nothing at all when the policy refuses the annulment', async () => {
    const { repository, calls } = prismaDouble({ reads: [entryRow()] });

    await expect(
      repository.reschedule(COMMAND, NEW_SLOT, () => {
        throw new InvalidAgendaTransitionError('CANCELLED', 'CANCELLED');
      }),
    ).rejects.toBeInstanceOf(InvalidAgendaTransitionError);

    expect(calls.map((call) => call.method)).toEqual(['entry.findFirst']);
  });

  it('AG-071 answers not-found for an entry of another site without writing', async () => {
    const { repository, calls } = prismaDouble({ reads: [null] });

    await expect(
      repository.reschedule(COMMAND, NEW_SLOT, annul),
    ).rejects.toBeInstanceOf(AgendaEntryNotFoundError);

    expect(calls.map((call) => call.method)).toEqual(['entry.findFirst']);
  });
});
