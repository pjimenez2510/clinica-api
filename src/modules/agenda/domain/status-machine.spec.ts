import { describe, expect, it } from 'vitest';

import {
  AgendaEntryNotFoundError,
  InvalidAgendaTransitionError,
  NoShowBeforeStartError,
} from './agenda.errors';
import type { AgendaEntryStatus, TransitionRead } from './agenda.repository';
import {
  type AgendaTransitionTarget,
  assertNoShowNotBeforeStart,
  assertTransition,
  effectsOf,
  planBlockRelease,
} from './status-machine';

/**
 * The status machine of SPEC §5, exhaustively and in both directions: every
 * admitted pair passes, and the whole complement of the table refuses. The
 * table is small enough that sampling it would only be a smaller guarantee
 * for no saving.
 */

const TARGETS: readonly AgendaTransitionTarget[] = [
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'FULFILLED',
  'CANCELLED',
  'NO_SHOW',
  'LEFT_WITHOUT_BEING_SEEN',
  'ENTERED_IN_ERROR',
];

const STATES: readonly AgendaEntryStatus[] = [
  'BOOKED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'FULFILLED',
  'CANCELLED',
  'NO_SHOW',
  'BLOCKED',
  'LEFT_WITHOUT_BEING_SEEN',
  'ENTERED_IN_ERROR',
];

/**
 * SPEC §5 verbatim. The test states the table so the code cannot be its own
 * oracle.
 *
 * `['CHECKED_IN', 'NO_SHOW']` IS ABSENT AND ITS ABSENCE IS AG-116. The pair
 * used to be here; taking it out of this list is what makes the exhaustive
 * complement below assert that the machine now REFUSES it.
 */
const ADMITTED: readonly [AgendaEntryStatus, AgendaTransitionTarget][] = [
  ['BOOKED', 'CONFIRMED'],
  ['BOOKED', 'CHECKED_IN'],
  ['BOOKED', 'CANCELLED'],
  ['BOOKED', 'NO_SHOW'],
  ['BOOKED', 'ENTERED_IN_ERROR'],
  ['CONFIRMED', 'CHECKED_IN'],
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'NO_SHOW'],
  ['CONFIRMED', 'ENTERED_IN_ERROR'],
  ['CHECKED_IN', 'IN_PROGRESS'],
  ['CHECKED_IN', 'CANCELLED'],
  ['CHECKED_IN', 'LEFT_WITHOUT_BEING_SEEN'],
  ['IN_PROGRESS', 'FULFILLED'],
];

const isAdmitted = (
  from: AgendaEntryStatus,
  to: AgendaTransitionTarget,
): boolean => ADMITTED.some(([f, t]) => f === from && t === to);

describe('the appointment status machine', () => {
  it('AG-040 admits every pair the table of SPEC §5 lists', () => {
    for (const [from, to] of ADMITTED) {
      expect(() => assertTransition('APPOINTMENT', from, to)).not.toThrow();
    }
  });

  it('AG-040 refuses every pair the table does not list, naming both ends', () => {
    for (const from of STATES) {
      for (const to of TARGETS) {
        if (isAdmitted(from, to)) continue;

        const rejection = (() => {
          try {
            assertTransition('APPOINTMENT', from, to);
            return undefined;
          } catch (error) {
            return error;
          }
        })();

        expect(rejection).toBeInstanceOf(InvalidAgendaTransitionError);
        expect((rejection as InvalidAgendaTransitionError).params).toEqual({
          from,
          to,
        });
      }
    }
  });

  it('AG-040 refuses everything out of FULFILLED, CANCELLED, NO_SHOW and BLOCKED: they are terminal', () => {
    for (const from of [
      'FULFILLED',
      'CANCELLED',
      'NO_SHOW',
      'BLOCKED',
    ] as const) {
      for (const to of TARGETS) {
        expect(() => assertTransition('APPOINTMENT', from, to)).toThrow(
          InvalidAgendaTransitionError,
        );
      }
    }
  });

  it('AG-046 refuses every appointment transition on a BLOCK, whatever its status', () => {
    // A block admits BOOKED, BLOCKED and CANCELLED as STORED states (the
    // database CHECK), but the six appointment targets all say something
    // about a patient a block does not have — even the pairs the table
    // would admit for an appointment.
    for (const from of ['BOOKED', 'BLOCKED', 'CANCELLED'] as const) {
      for (const to of TARGETS) {
        expect(() => assertTransition('BLOCK', from, to)).toThrow(
          InvalidAgendaTransitionError,
        );
      }
    }
  });

  it('AG-040 names the current state in Spanish in the refusal', () => {
    const rejection = (() => {
      try {
        assertTransition('APPOINTMENT', 'FULFILLED', 'CANCELLED');
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect((rejection as InvalidAgendaTransitionError).userTitle).toContain(
      'Atendida',
    );
  });
});

describe('the no-show clock rule', () => {
  const startsAt = new Date('2026-09-14T13:00:00Z');

  it('AG-043 refuses a no-show before the appointment starts', () => {
    expect(() =>
      assertNoShowNotBeforeStart(startsAt, new Date('2026-09-14T12:59:59Z')),
    ).toThrow(NoShowBeforeStartError);
  });

  it('AG-043 admits a no-show at the exact start instant', () => {
    // At 08:00 the appointment has begun: from here on the absence is real.
    expect(() =>
      assertNoShowNotBeforeStart(startsAt, new Date('2026-09-14T13:00:00Z')),
    ).not.toThrow();
  });

  it('AG-043 admits a no-show after the start', () => {
    expect(() =>
      assertNoShowNotBeforeStart(startsAt, new Date('2026-09-14T13:20:00Z')),
    ).not.toThrow();
  });
});

describe('the effects of each arrival', () => {
  const now = new Date('2026-09-14T13:05:00Z');

  it('AG-041, AG-127 stamp the arrival instant and the only typed subject status', () => {
    // The two are ONE fact — the person crossed the door — and `ARRIVED` is
    // the single value AG-122 lets anybody type, because it is the only one
    // that leaves no other trace in the system.
    expect(effectsOf('CHECKED_IN', now)).toEqual({
      checkedInAt: now,
      subjectStatus: 'ARRIVED',
      subjectStatusAt: now,
    });
  });

  it('AG-116 releases the slot and marks the patient DEPARTED', () => {
    // The hour is empty in fact (AG-042's reasoning), and AG-127 closes the
    // one outcome that would otherwise strand somebody on the board forever:
    // whoever left without being seen never passes the cashier.
    expect(effectsOf('LEFT_WITHOUT_BEING_SEEN', now)).toEqual({
      releasedAt: now,
      // Its OWN instant since `20260820121023_agenda_outcomes_and_board`, and
      // the database now refuses the status without it: AG-140 filters this
      // outcome by date over `agenda_entry`, like its three neighbours, and
      // making it alone join against the trail would have made the metric a
      // different query for an asymmetry that answers nothing.
      leftWithoutBeingSeenAt: now,
      subjectStatus: 'DEPARTED',
      subjectStatusAt: now,
    });
  });

  it('AG-117 releases the slot and stamps nothing that belongs to an annulment', () => {
    // `cancelled_at` is what says «se anuló una cita que existía»; this says
    // the recorded fact never happened, and one column for both acts would
    // make the row unable to answer which of the two occurred. Hence its own
    // instant — and, one layer up, its own reason column too.
    expect(effectsOf('ENTERED_IN_ERROR', now)).toEqual({
      releasedAt: now,
      enteredInErrorAt: now,
    });
  });

  it('AG-042 stamps the no-show and releases the slot in the same stroke', () => {
    // `releasedAt` is the predicate of the EXCLUDE constraints: setting it
    // IS what lets the same slot be booked again.
    expect(effectsOf('NO_SHOW', now)).toEqual({
      noShowAt: now,
      releasedAt: now,
    });
  });

  it('AG-044 stamps the annulment and releases the slot', () => {
    expect(effectsOf('CANCELLED', now)).toEqual({
      cancelledAt: now,
      releasedAt: now,
    });
  });

  it('AG-004 stamps no column for CONFIRMED, IN_PROGRESS or FULFILLED: the history row is their record', () => {
    expect(effectsOf('CONFIRMED', now)).toEqual({});
    expect(effectsOf('IN_PROGRESS', now)).toEqual({});
    expect(effectsOf('FULFILLED', now)).toEqual({});
  });
});

describe('deshacer un bloqueo (AG-114)', () => {
  const now = new Date('2026-09-14T13:05:00Z');

  const readOf = (overrides: Partial<TransitionRead> = {}): TransitionRead => ({
    id: 'entry-1',
    kind: 'BLOCK',
    status: 'BLOCKED',
    startsAt: new Date('2026-09-14T13:00:00Z'),
    releasedAt: null,
    hasEncounter: false,
    ...overrides,
  });

  it('AG-114 releases the interval and never deletes: `releasedAt` is the effect', () => {
    // `blocks_calendar AND released_at IS NULL` is the predicate of both
    // EXCLUDE constraints, so stamping it IS what gives the hour back.
    expect(planBlockRelease(readOf(), now)).toEqual({
      to: 'CANCELLED',
      effects: { cancelledAt: now, releasedAt: now },
    });
  });

  it('AG-114 refuses a block that was already released', () => {
    expect(() =>
      planBlockRelease(
        readOf({ status: 'CANCELLED', releasedAt: new Date() }),
        now,
      ),
    ).toThrow(InvalidAgendaTransitionError);
  });

  it('AG-114 refuses an appointment exactly like a missing entry', () => {
    // The route addresses `blocks/:id`. Telling an appointment apart there
    // would confirm foreign entries to whoever guesses identifiers (AG-071).
    expect(() =>
      planBlockRelease(readOf({ kind: 'APPOINTMENT', status: 'BOOKED' }), now),
    ).toThrow(AgendaEntryNotFoundError);
  });
});
