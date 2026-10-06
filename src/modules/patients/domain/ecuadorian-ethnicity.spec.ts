import { describe, expect, it } from 'vitest';

import {
  ECUADOR_COUNTRY_CODE,
  ethnicityApplies,
  fieldsForeignNationalityClears,
} from './ecuadorian-ethnicity';

/** Mestizo/a, `6` of column 12. Any of the nine would do: the rule ignores which. */
const MESTIZO = '00000000-0000-4000-8000-000000000006';

/**
 * PA-059 as the code applies it since PA-065: what a chart of this country
 * would have emptied, with only the ethnicity declared.
 */
const clearedFor = (
  countryOfNationalityCode: string | null,
  ethnicityConceptId: string | null,
) =>
  fieldsForeignNationalityClears({
    countryOfNationalityCode,
    ethnicityConceptId,
    nationalityConceptId: null,
    peopleConceptId: null,
  });

describe('PA-059 · cuándo se puede declarar autoidentificación étnica', () => {
  it('PA-059 admits an ethnicity when the country of nationality is Ecuador', () => {
    expect(clearedFor(ECUADOR_COUNTRY_CODE, MESTIZO)).toEqual([]);
  });

  it('PA-059 does not keep an ethnicity when the country of nationality is another one', () => {
    // The instructivo says it twice: «Aplica para nacionalidad Ecuatoriana»
    // over column 12, and «si el usuario NO es ecuatoriano, pase a la columna
    // 15 dejando los espacios en blanco» over column 11.
    expect(clearedFor('VEN', MESTIZO)).toEqual(['ethnicityConceptId']);
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
    expect(clearedFor(null, MESTIZO)).toEqual([]);
  });

  it('PA-059 admits any country, and none, when there is no ethnicity', () => {
    for (const countryOfNationalityCode of [
      ECUADOR_COUNTRY_CODE,
      'VEN',
      null,
    ]) {
      expect(
        clearedFor(countryOfNationalityCode, null),
        `country ${countryOfNationalityCode ?? 'ausente'}`,
      ).toEqual([]);
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

describe('PA-065 · lo que una nacionalidad extranjera vacía', () => {
  const declared = {
    ethnicityConceptId: 'ethnicity',
    nationalityConceptId: 'nationality',
    peopleConceptId: 'people',
  };

  it('PA-065 empties ethnicity, nationality and people of a foreign chart', () => {
    expect(
      fieldsForeignNationalityClears({
        countryOfNationalityCode: 'VEN',
        ...declared,
      }),
    ).toEqual([
      'ethnicityConceptId',
      'nationalityConceptId',
      'peopleConceptId',
    ]);
  });

  it('PA-065 names only the fields that hold something', () => {
    expect(
      fieldsForeignNationalityClears({
        countryOfNationalityCode: 'COL',
        ethnicityConceptId: 'ethnicity',
        nationalityConceptId: null,
        peopleConceptId: null,
      }),
    ).toEqual(['ethnicityConceptId']);
  });

  it('PA-065 empties nothing on an Ecuadorian chart or one with no country', () => {
    for (const country of [ECUADOR_COUNTRY_CODE, null]) {
      expect(
        fieldsForeignNationalityClears({
          countryOfNationalityCode: country,
          ...declared,
        }),
      ).toEqual([]);
    }
  });
});
