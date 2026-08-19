import { describe, expect, it } from 'vitest';

import {
  KICHWA_NATIONALITY_CODE,
  isKichwaNationality,
  peopleContradictsNationality,
} from './indigenous-people';

/**
 * The four combinations, and they are four because the rule has two inputs.
 *
 * The same shape as `indigenous-nationality.spec.ts` one step down the chain,
 * and deliberately so: ethnicity → indigenous nationality → people is one rule
 * written three times over three columns of the same form, and a reader who
 * knows one should recognise the next.
 */

/** Otavalo, `8` of column 14. Any of the 18 would do: the rule ignores which. */
const OTAVALO = '00000000-0000-4000-8000-000000000008';

describe('PA-056 · cuándo se puede declarar un pueblo', () => {
  it('PA-056 admits a people when the indigenous nationality is Kichwa', () => {
    expect(
      peopleContradictsNationality({
        nationalityCode: KICHWA_NATIONALITY_CODE,
        peopleConceptId: OTAVALO,
      }),
    ).toBe(false);
  });

  it('PA-056 refuses a people when the indigenous nationality is another one', () => {
    // `8` is Shuar in column 13 of the instructivo. A chart that says Shuar and
    // Otavalo at once is the contradiction the ministry does not expect, and
    // nothing downstream fails: it comes back with the monthly report.
    expect(
      peopleContradictsNationality({
        nationalityCode: '8',
        peopleConceptId: OTAVALO,
      }),
    ).toBe(true);
  });

  it('PA-056 refuses a people when there is no indigenous nationality at all', () => {
    // The form enables column 14 on an affirmative answer to column 13, so
    // «nobody has asked yet» is not the same as «Kichwa».
    expect(
      peopleContradictsNationality({
        nationalityCode: null,
        peopleConceptId: OTAVALO,
      }),
    ).toBe(true);
  });

  it('PA-056 admits any nationality, and none, when there is no people', () => {
    // The field is optional at registration (D-028): a chart with a nationality
    // and no people is the ordinary case, not a half-filled one.
    for (const nationalityCode of [KICHWA_NATIONALITY_CODE, '8', null]) {
      expect(
        peopleContradictsNationality({
          nationalityCode,
          peopleConceptId: null,
        }),
        `nationality ${nationalityCode ?? 'ausente'}`,
      ).toBe(false);
    }
  });

  it('PA-056 recognises Kichwa by its CODE and not by its wording', () => {
    /**
     * ⚠️ AND THE CODE MOVED ONCE ALREADY. Kichwa is `6` in the instructivo and
     * was `14` in the INEC list this catalogue held until 19-08-2026 — where
     * `14` now means Andoa. A rule comparing «Kichwa» as a string, or holding
     * the old number, would stop being true without anything failing.
     */
    expect(isKichwaNationality(KICHWA_NATIONALITY_CODE)).toBe(true);
    expect(isKichwaNationality('Kichwa')).toBe(false);
    expect(isKichwaNationality('KICHWA')).toBe(false);
    expect(isKichwaNationality('14')).toBe(false);
  });
});
