import { describe, expect, it } from 'vitest';

import { ECUADOR_COUNTRY_CODE } from './ecuadorian-ethnicity';
import { INDIGENOUS_ETHNICITY_CODE } from './indigenous-nationality';
import { rdacaaMissingFields } from './rdacaa-completeness';

const CONCEPT = '00000000-0000-4000-8000-000000000001';

/**
 * `6` is «Mestizo/a» in question 11 of the INEC 2022 census — the same list
 * `prisma/seed-rdacaa.mts` loads. ANY code that is not the indigenous one would
 * do; this one is simply the majority of the charts this rule is about.
 */
const MESTIZO_ETHNICITY_CODE = '6';

const complete = {
  hasDefinitiveDocument: true,
  countryOfNationalityCode: ECUADOR_COUNTRY_CODE,
  ethnicityConceptId: CONCEPT,
  ethnicityCode: INDIGENOUS_ETHNICITY_CODE,
  nationalityConceptId: CONCEPT,
  residenceParishConceptId: CONCEPT,
};

describe('what the RDACAA still needs from a chart', () => {
  it('PA-032 names nothing when the four data are recorded', () => {
    expect(rdacaaMissingFields(complete)).toEqual([]);
  });

  it('PA-032 names the ethnicity a chart was registered without', () => {
    // Registered at three in the morning with a newborn in the room. The chart
    // exists — that is D-028 — and the indicator says what to complete.
    expect(
      rdacaaMissingFields({
        ...complete,
        ethnicityConceptId: null,
        ethnicityCode: null,
      }),
    ).toEqual(['ethnicityConceptId']);
  });

  it('PA-032 names every missing field of a provisional chart at once', () => {
    // Admission fixes a form, not one field per round trip.
    expect(
      rdacaaMissingFields({
        hasDefinitiveDocument: false,
        countryOfNationalityCode: null,
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
        residenceParishConceptId: null,
      }),
    ).toEqual([
      'identifier',
      'ethnicityConceptId',
      'nationalityConceptId',
      'residenceParishConceptId',
    ]);
  });

  it('PA-032 does NOT count gender identity as missing', () => {
    // REQ-022 enumerates document, sex, ethnicity, nationality, age and
    // residence, and gender identity is not among them (PA-029 records it
    // anyway). Flagging a chart for a datum the report never asks for turns
    // the indicator into noise admission learns to ignore.
    expect(
      rdacaaMissingFields({
        ...complete,
        // No `genderIdentityConceptId` key exists on the input at all: the
        // shape is the guarantee, not a filter somebody has to remember.
      }),
    ).toEqual([]);
  });

  it('PA-032 names the document of a chart registered without one', () => {
    expect(
      rdacaaMissingFields({ ...complete, hasDefinitiveDocument: false }),
    ).toEqual(['identifier']);
  });

  // ---------------------------------------------------------------------------
  // The three branches of D-037, each with the nationality there and missing.
  //
  // The nationality is only DEMANDED of the charts the ministry enables the
  // field for. PA-027 refuses to write it on any other, so counting it there
  // left every non-indigenous chart — the majority — permanently incomplete
  // over a box the system itself forbids filling in, and an indicator nobody
  // can drive to zero is one admission learns to ignore.
  // ---------------------------------------------------------------------------

  it('PA-032 asks an «Indígena» chart for the nationality it is missing', () => {
    expect(
      rdacaaMissingFields({ ...complete, nationalityConceptId: null }),
    ).toEqual(['nationalityConceptId']);
  });

  it('PA-032 names nothing on an «Indígena» chart that declares its nationality', () => {
    expect(rdacaaMissingFields(complete)).toEqual([]);
  });

  it('PA-032 does NOT ask a chart that is not «Indígena» for a nationality PA-027 forbids it', () => {
    // The whole point of D-037: a «Mestizo/a» chart with everything else
    // recorded is COMPLETE, and cannot be anything else — PA-027 rejects the
    // very correction that would clear this field.
    expect(
      rdacaaMissingFields({
        ...complete,
        ethnicityCode: MESTIZO_ETHNICITY_CODE,
        nationalityConceptId: null,
      }),
    ).toEqual([]);
  });

  it('PA-032 names nothing either when a chart that is not «Indígena» holds a nationality', () => {
    // A state PA-027 no longer lets anybody reach through the API, and older
    // rows may still be in it. The indicator does not report it as missing
    // something — it is not: the datum is there.
    expect(
      rdacaaMissingFields({
        ...complete,
        ethnicityCode: MESTIZO_ETHNICITY_CODE,
      }),
    ).toEqual([]);
  });

  it('PA-032 still asks for the nationality while the ethnicity is missing', () => {
    // Nobody has asked the question yet, so nobody knows whether the field
    // applies. Dropping it here would let a chart look complete and then need
    // the nationality the moment somebody records «Indígena».
    expect(
      rdacaaMissingFields({
        ...complete,
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
      }),
    ).toEqual(['ethnicityConceptId', 'nationalityConceptId']);
  });

  it('PA-032 names only the ethnicity when it is missing and the nationality is there', () => {
    expect(
      rdacaaMissingFields({
        ...complete,
        ethnicityConceptId: null,
        ethnicityCode: null,
      }),
    ).toEqual(['ethnicityConceptId']);
  });

  it('PA-059 does NOT ask a foreign chart for the ethnicity PA-059 forbids it', () => {
    /**
     * The instructivo tells the person filling the form to skip columns 12 to
     * 14 for a patient who is not Ecuadorian, and PA-059 refuses to record
     * them. Counting the ethnicity here would leave every foreign chart
     * permanently incomplete over a box THE SYSTEM ITSELF REFUSES TO LET
     * ANYBODY FILL IN — which is literally the defect D-037 fixed one step
     * further down the chain.
     */
    expect(
      rdacaaMissingFields({
        ...complete,
        countryOfNationalityCode: 'VEN',
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
      }),
    ).toEqual([]);
  });

  it('PA-059 does NOT ask a foreign chart for the nationality either', () => {
    // The nationality falls with the ethnicity and needs no condition of its
    // own: PA-027 does not admit it without an «Indígena» ethnicity, and a
    // foreign chart cannot hold one.
    expect(
      rdacaaMissingFields({
        ...complete,
        countryOfNationalityCode: 'COL',
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
        residenceParishConceptId: null,
      }),
    ).toEqual(['residenceParishConceptId']);
  });

  it('PA-059 still asks for the ethnicity while no country has been recorded', () => {
    /**
     * ⚠️ THE BRANCH THAT IS EASY TO LOSE, and the same one D-037 wrote down for
     * the nationality: until somebody has asked the question, nobody knows
     * whether the field applies. Dropping it here would let a chart read as
     * complete and start missing the ethnicity the moment a country of `ECU` is
     * recorded — the indicator would go backwards with nothing about the report
     * having changed.
     */
    expect(
      rdacaaMissingFields({
        ...complete,
        countryOfNationalityCode: null,
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
      }),
    ).toEqual(['ethnicityConceptId', 'nationalityConceptId']);
  });

  it('PA-059 asks an Ecuadorian chart for everything it is missing', () => {
    // `ECU` is the ordinary case and must behave exactly as an unrecorded
    // country does: the country is a gate, not a fourth required datum.
    expect(
      rdacaaMissingFields({
        ...complete,
        countryOfNationalityCode: ECUADOR_COUNTRY_CODE,
        ethnicityConceptId: null,
        ethnicityCode: null,
        nationalityConceptId: null,
      }),
    ).toEqual(['ethnicityConceptId', 'nationalityConceptId']);
  });
});
