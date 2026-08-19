import { describe, expect, it } from 'vitest';

import {
  ECUADOR_COUNTRY_CODE,
  ethnicityApplies,
  ethnicityContradictsCountry,
} from './ecuadorian-ethnicity';

/** Mestizo/a, `6` of column 12. Any of the nine would do: the rule ignores which. */
const MESTIZO = '00000000-0000-4000-8000-000000000006';

describe('PA-059 · cuándo se puede declarar autoidentificación étnica', () => {
  it('PA-059 admits an ethnicity when the country of nationality is Ecuador', () => {
    expect(
      ethnicityContradictsCountry({
        countryOfNationalityCode: ECUADOR_COUNTRY_CODE,
        ethnicityConceptId: MESTIZO,
      }),
    ).toBe(false);
  });

  it('PA-059 refuses an ethnicity when the country of nationality is another one', () => {
    // The instructivo says it twice: «Aplica para nacionalidad Ecuatoriana»
    // over column 12, and «si el usuario NO es ecuatoriano, pase a la columna
    // 15 dejando los espacios en blanco» over column 11.
    expect(
      ethnicityContradictsCountry({
        countryOfNationalityCode: 'VEN',
        ethnicityConceptId: MESTIZO,
      }),
    ).toBe(true);
  });

  it('PA-059 admits an ethnicity when no country has been recorded', () => {
    /**
     * ⚠️ THIS IS THE BRANCH THAT MUST NOT BE «NOT ECUADOR».
     *
     * The country is optional (PA-053) and most charts carry none, so refusing
     * here would make the ethnicity unrecordable for almost every patient in
     * the register — the exact opposite of what the column exists for. It is
     * the mirror image of PA-027's missing-ethnicity branch, read the other way
     * round: there the conditional field is refused while the question is
     * unanswered, here the field is the QUESTION and it is allowed.
     */
    expect(
      ethnicityContradictsCountry({
        countryOfNationalityCode: null,
        ethnicityConceptId: MESTIZO,
      }),
    ).toBe(false);
  });

  it('PA-059 admits any country, and none, when there is no ethnicity', () => {
    for (const countryOfNationalityCode of [
      ECUADOR_COUNTRY_CODE,
      'VEN',
      null,
    ]) {
      expect(
        ethnicityContradictsCountry({
          countryOfNationalityCode,
          ethnicityConceptId: null,
        }),
        `country ${countryOfNationalityCode ?? 'ausente'}`,
      ).toBe(false);
    }
  });

  it('PA-059 recognises Ecuador by its alpha-3 code and not by its name', () => {
    // The chart stores three letters, exactly like
    // `patient_identifier.issuing_country`, and the name is resolved from the
    // `COUNTRY` catalogue when the chart is opened (PA-053). Comparing the name
    // would break the day the catalogue reworded it.
    expect(ethnicityApplies(ECUADOR_COUNTRY_CODE)).toBe(true);
    expect(ethnicityApplies(null)).toBe(true);
    expect(ethnicityApplies('Ecuador')).toBe(false);
    expect(ethnicityApplies('ecu')).toBe(false);
    expect(ethnicityApplies('EC')).toBe(false);
  });
});
