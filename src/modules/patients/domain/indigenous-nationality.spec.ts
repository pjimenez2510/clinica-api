import { describe, expect, it } from 'vitest';

import {
  INDIGENOUS_ETHNICITY_CODE,
  isIndigenousEthnicity,
  nationalityContradictsEthnicity,
} from './indigenous-nationality';

/**
 * The four combinations, and they are four because the rule has two inputs.
 *
 * What is NOT here: anything about who refuses it or with what status. That is
 * the service and the HTTP contract. This file only decides whether the chart
 * that would result is a chart the RDACAA can report.
 */

/** Kichwa, `14` of the INEC's `P12`. Any of the 34 would do: the rule ignores which. */
const KICHWA = '00000000-0000-4000-8000-000000000014';

describe('PA-027 · cuándo se puede declarar nacionalidad o pueblo indígena', () => {
  it('PA-027 admits a nationality when the ethnicity is the indigenous one', () => {
    expect(
      nationalityContradictsEthnicity({
        ethnicityCode: INDIGENOUS_ETHNICITY_CODE,
        nationalityConceptId: KICHWA,
      }),
    ).toBe(false);
  });

  it('PA-027 refuses a nationality when the ethnicity is another one', () => {
    // `6` is Mestizo/a in the INEC's question 11. A chart that says Mestizo/a
    // and Kichwa at once is the contradiction the ministry does not expect, and
    // nothing downstream fails: it comes back with the monthly report.
    expect(
      nationalityContradictsEthnicity({
        ethnicityCode: '6',
        nationalityConceptId: KICHWA,
      }),
    ).toBe(true);
  });

  it('PA-027 refuses a nationality when there is no ethnicity at all', () => {
    // The form enables the field on an affirmative answer, so «todavía nadie lo
    // ha preguntado» is not the same as «Indígena». The chart says what it is
    // missing instead (PA-032).
    expect(
      nationalityContradictsEthnicity({
        ethnicityCode: null,
        nationalityConceptId: KICHWA,
      }),
    ).toBe(true);
  });

  it('PA-027 admits any ethnicity, and none, when there is no nationality', () => {
    // The field is optional at registration (D-028): a chart with an ethnicity
    // and no nationality is the ordinary case, not a half-filled one.
    for (const ethnicityCode of [INDIGENOUS_ETHNICITY_CODE, '6', null]) {
      expect(
        nationalityContradictsEthnicity({
          ethnicityCode,
          nationalityConceptId: null,
        }),
        `ethnicity ${ethnicityCode ?? 'ausente'}`,
      ).toBe(false);
    }
  });

  it('PA-027 recognises the indigenous category by its CODE and not by its wording', () => {
    /**
     * INEC rewords its categories between censuses and every chart keeps the
     * wording it was recorded with (PA-026), so a rule that compared «Indígena»
     * as a string would stop holding without anything failing.
     */
    expect(isIndigenousEthnicity(INDIGENOUS_ETHNICITY_CODE)).toBe(true);
    expect(isIndigenousEthnicity('Indígena')).toBe(false);
    expect(isIndigenousEthnicity('INDIGENA')).toBe(false);
    expect(isIndigenousEthnicity('01')).toBe(false);
  });
});
