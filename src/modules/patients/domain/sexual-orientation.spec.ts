import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  SEXUAL_ORIENTATION_MIN_AGE_YEARS,
  sexualOrientationBelowMinimumAge,
} from './sexual-orientation';

/** Heterosexual, `4` of column 7. Any of the five would do: the rule ignores which. */
const HETEROSEXUAL = '00000000-0000-4000-8000-000000000004';

const on = parseClinicalDate('2026-08-19');

describe('PA-057 · desde qué edad se puede declarar orientación sexual', () => {
  it('PA-057 admits a sexual orientation on the tenth birthday', () => {
    // «A partir de los 10 años de edad» includes the day itself: the boundary
    // is the one place a threshold is read wrong, so it has its own case.
    expect(
      sexualOrientationBelowMinimumAge(
        {
          birthDate: parseClinicalDate('2016-08-19'),
          sexualOrientationConceptId: HETEROSEXUAL,
        },
        on,
      ),
    ).toBe(false);
  });

  it('PA-057 refuses a sexual orientation the day before the tenth birthday', () => {
    expect(
      sexualOrientationBelowMinimumAge(
        {
          birthDate: parseClinicalDate('2016-08-20'),
          sexualOrientationConceptId: HETEROSEXUAL,
        },
        on,
      ),
    ).toBe(true);
  });

  it('PA-057 admits any age when there is no sexual orientation', () => {
    // The field is optional (D-028), and a newborn's chart with no orientation
    // is the ordinary case rather than a half-filled one.
    expect(
      sexualOrientationBelowMinimumAge(
        {
          birthDate: parseClinicalDate('2026-08-01'),
          sexualOrientationConceptId: null,
        },
        on,
      ),
    ).toBe(false);
  });

  it('PA-057 keeps the ministry threshold in one place', () => {
    // The number is the instructivo's, and the day it moves, moving it here has
    // to be the whole change. Same reason as `NEONATE_MAX_AGE_DAYS`.
    expect(SEXUAL_ORIENTATION_MIN_AGE_YEARS).toBe(10);
  });

  it('PA-057 decides the birthday on the calendar and never on elapsed time', () => {
    /**
     * A leap-year birth is where dividing milliseconds by an average year goes
     * wrong, and «off by a day» here is the difference between accepting the
     * chart and refusing it. `29 February 2016` completes ten years on
     * `1 March 2026`, because 2026 has no 29 February.
     */
    const leapling = parseClinicalDate('2016-02-29');
    expect(
      sexualOrientationBelowMinimumAge(
        { birthDate: leapling, sexualOrientationConceptId: HETEROSEXUAL },
        parseClinicalDate('2026-02-28'),
      ),
    ).toBe(true);
    expect(
      sexualOrientationBelowMinimumAge(
        { birthDate: leapling, sexualOrientationConceptId: HETEROSEXUAL },
        parseClinicalDate('2026-03-01'),
      ),
    ).toBe(false);
  });
});
