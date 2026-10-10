import { beforeEach, describe, expect, it } from 'vitest';

import {
  parseClinicalDate,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import { clinicalDateToday } from './priority-groups';

import {
  GENDER_IDENTITY_MIN_AGE_YEARS,
  genderIdentityBelowMinimumAge,
} from './gender-identity';

/** Any concept of column 8: the rule ignores which. */
const SOME_IDENTITY = '00000000-0000-4000-8000-000000000008';

/** `today` moved back by whole years, on the same calendar day. */
function yearsBefore(today: ClinicalDate, years: number): ClinicalDate {
  const [year, month, day] = today.toString().split('-');
  return parseClinicalDate(`${Number(year) - years}-${month}-${day}`);
}

/** The calendar day after `date`, read as a calendar and not as elapsed time. */
function dayAfter(date: ClinicalDate): ClinicalDate {
  const next = new Date(`${date.toString()}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return parseClinicalDate(next.toISOString().slice(0, 10));
}

describe('PA-071 · desde qué edad se puede declarar la identidad de género', () => {
  // The reference date comes from the clinic's clock, never written by hand.
  // The 29 February is the one day `yearsBefore` cannot shift; step past it.
  let today: ClinicalDate;
  beforeEach(() => {
    const now = new Date();
    today = clinicalDateToday(now);
    if (today.toString().endsWith('-02-29')) today = dayAfter(today);
  });

  it('PA-071 admits a gender identity on the tenth birthday', () => {
    expect(
      genderIdentityBelowMinimumAge(
        {
          birthDate: yearsBefore(today, 10),
          genderIdentityConceptId: SOME_IDENTITY,
        },
        today,
      ),
    ).toBe(false);
  });

  it('PA-071 refuses a gender identity the day before the tenth birthday', () => {
    expect(
      genderIdentityBelowMinimumAge(
        {
          birthDate: dayAfter(yearsBefore(today, 10)),
          genderIdentityConceptId: SOME_IDENTITY,
        },
        today,
      ),
    ).toBe(true);
  });

  it('PA-071 admits any age when there is no gender identity', () => {
    expect(
      genderIdentityBelowMinimumAge(
        { birthDate: today, genderIdentityConceptId: null },
        today,
      ),
    ).toBe(false);
  });

  it('PA-071 shares the ministry threshold with column 7', () => {
    expect(GENDER_IDENTITY_MIN_AGE_YEARS).toBe(10);
  });
});
