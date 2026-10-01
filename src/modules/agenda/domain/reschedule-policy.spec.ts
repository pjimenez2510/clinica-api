import { describe, expect, it } from 'vitest';

import {
  AgendaEntryHasEncounterError,
  CancellationReasonRequiredError,
  InvalidAgendaTransitionError,
} from './agenda.errors';
import type { TransitionRead } from './agenda.repository';
import { planReschedule } from './reschedule-policy';

/**
 * What rescheduling decides about the ORIGINAL entry, with no database in
 * sight.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. It pins the shape of the decision — the
 * original is released and never moved (AG-050), and the decision is refused
 * before anything is planned when the entry cannot be annulled. It cannot
 * prove AG-052, because "the release does not happen when the new entry fails"
 * is a property of ONE transaction and only PostgreSQL can be asked about it:
 * that is `test/integration/agenda-reschedule.spec.ts`.
 */

/** 08:00 in Guayaquil on Monday 14 September 2026. */
const EIGHT = new Date('2026-09-14T13:00:00Z');
const NOW = new Date('2026-09-14T12:00:00Z');

function aRead(overrides: Partial<TransitionRead> = {}): TransitionRead {
  return {
    id: 'entry-1',
    kind: 'APPOINTMENT',
    status: 'BOOKED',
    startsAt: EIGHT,
    releasedAt: null,
    hasEncounter: false,
    encounterHasNote: false,
    ...overrides,
  };
}

describe('planReschedule', () => {
  it('AG-050 releases the original slot and leaves its interval untouched', () => {
    const change = planReschedule({
      entry: aRead(),
      reason: 'Paciente pide otra hora',
      now: NOW,
    });

    expect(change.to).toBe('CANCELLED');
    // «Liberar el cupo» IS `released_at`: it is the predicate of the three
    // `EXCLUDE` constraints, so this instant is what puts the slot back on
    // offer without deleting anything.
    expect(change.effects.releasedAt).toBe(NOW);
    expect(change.effects.cancelledAt).toBe(NOW);
    // AG-050's second half, asserted on the KEYS rather than on a value: the
    // plan may stamp only these four columns, so nothing it returns can move
    // `starts_at` or `ends_at` of the row that already exists. A reschedule
    // that updated the interval would erase that the appointment ever was at
    // the first hour, which is what §5's immutable history is for.
    expect(Object.keys(change.effects).sort()).toEqual([
      'cancelledAt',
      'releasedAt',
    ]);
  });

  it('AG-051 carries the reason into the entry and into the history row', () => {
    const change = planReschedule({
      entry: aRead(),
      reason: 'Paciente pide otra hora',
      now: NOW,
    });

    // The traversable half of AG-051 is `rescheduled_from_id`, which the
    // adapter writes; this is the half a person reads — the annulment says
    // WHY, in both places E2 already writes.
    expect(change.cancellationNote).toBe('Paciente pide otra hora');
    expect(change.historyNote).toBe('Paciente pide otra hora');
  });

  it('AG-044 refuses a reschedule with no reason before planning any release', () => {
    expect(() =>
      planReschedule({ entry: aRead(), reason: '   ', now: NOW }),
    ).toThrow(CancellationReasonRequiredError);
    expect(() =>
      planReschedule({ entry: aRead(), reason: undefined, now: NOW }),
    ).toThrow(CancellationReasonRequiredError);
  });

  it('AG-040 refuses rescheduling from a state that admits no annulment', () => {
    for (const status of ['FULFILLED', 'CANCELLED', 'NO_SHOW'] as const) {
      expect(() =>
        planReschedule({
          entry: aRead({ status }),
          reason: 'Paciente pide otra hora',
          now: NOW,
        }),
      ).toThrow(InvalidAgendaTransitionError);
    }
  });

  it('AG-046 refuses rescheduling a block, which has no patient to move', () => {
    expect(() =>
      planReschedule({
        entry: aRead({ kind: 'BLOCK', status: 'BOOKED' }),
        reason: 'Se corre la reunión',
        now: NOW,
      }),
    ).toThrow(InvalidAgendaTransitionError);
  });

  it('AG-045 refuses rescheduling an appointment that already has an encounter', () => {
    expect(() =>
      planReschedule({
        entry: aRead({ status: 'CHECKED_IN', hasEncounter: true }),
        reason: 'Paciente pide otra hora',
        now: NOW,
      }),
    ).toThrow(AgendaEntryHasEncounterError);
  });
});
