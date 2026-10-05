import { describe, expect, it } from 'vitest';

import {
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

import { awaitingCheckoutSince } from './awaiting-checkout';

/** Today's clinic date, from the run's clock: no date is written by hand. */
const today = clinicalDateOf(new Date());

describe('the window of visits still owed', () => {
  it('BI-181 starts at midnight in Ecuador six days before today, counting today as the seventh', () => {
    const morning = atWallClock(today, WallClockTime.fromMinutes(9 * 60));

    expect(awaitingCheckoutSince(morning)).toEqual(
      startOfClinicalDay(addDays(today, -6)),
    );
  });

  it('BI-181 BI-002 at 21:30 in Guayaquil, when the UTC date is already tomorrow, still counts from the clinic date', () => {
    const evening = atWallClock(today, WallClockTime.fromMinutes(21 * 60 + 30));
    // Control: the instant really is on the next UTC date.
    expect(evening.toISOString().slice(0, 10)).toBe(addDays(today, 1));

    expect(clinicalDateOf(awaitingCheckoutSince(evening))).toBe(
      addDays(today, -6),
    );
  });
});
