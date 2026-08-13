import { describe, expect, it } from 'vitest';

import {
  InvalidAgendaTransitionError,
  NoShowBeforeStartError,
} from './agenda.errors';
import type { AgendaEntryStatus } from './agenda.repository';
import {
  type AgendaTransitionTarget,
  assertNoShowNotBeforeStart,
  assertTransition,
  effectsOf,
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
];

/** SPEC §5 verbatim. The test states the table so the code cannot be its own oracle. */
const ADMITTED: readonly [AgendaEntryStatus, AgendaTransitionTarget][] = [
  ['BOOKED', 'CONFIRMED'],
  ['BOOKED', 'CHECKED_IN'],
  ['BOOKED', 'CANCELLED'],
  ['BOOKED', 'NO_SHOW'],
  ['CONFIRMED', 'CHECKED_IN'],
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'NO_SHOW'],
  ['CHECKED_IN', 'IN_PROGRESS'],
  ['CHECKED_IN', 'CANCELLED'],
  ['CHECKED_IN', 'NO_SHOW'],
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

  it('AG-041 stamps the real arrival instant on CHECKED_IN', () => {
    expect(effectsOf('CHECKED_IN', now)).toEqual({ checkedInAt: now });
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
