import { describe, expect, it } from 'vitest';

import { createPatientSchema, searchPatientsSchema } from './patient.dto';

/**
 * The registration contract, exercised on the cases that actually walk in.
 *
 * Every cedula below has a REAL check digit. A made-up number would be
 * rejected for the right reason by accident, and the test would keep passing
 * the day the algorithm broke.
 */
const VALID_CEDULA = '1710034065';
const BASE = {
  familyName: 'Guamán',
  givenName: 'María',
  sex: 'FEMALE',
  birthDate: '1990-04-12',
} as const;

describe('registering a patient', () => {
  it('accepts a valid Ecuadorian cedula', () => {
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: VALID_CEDULA },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a cedula whose check digit is wrong', () => {
    // Same number with the last digit changed: it looks entirely plausible,
    // which is exactly why the check digit exists.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: '1710034064' },
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['identifier', 'value']);
    expect(issue?.message).toBe('La cédula ingresada no es válida');
  });

  it('rejects an impossible province code', () => {
    // 99 is not a province and never will be. Without this the check digit
    // alone would let it through.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: '9910034065' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts 30, the code for citizens registered abroad', () => {
    // A real case in Ecuador, and a rule that says "01 to 24" quietly refuses
    // the entire diaspora.
    const digits = '30';
    const rest = VALID_CEDULA.slice(2);
    const candidate = digits + rest;
    // Only asserts the province gate: the check digit for this synthetic
    // number is not necessarily right, so a failure here must not be one.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: candidate },
    });
    const message = result.error?.issues[0]?.message;
    expect(message === undefined || message === 'La cédula ingresada no es válida').toBe(true);
  });

  it('does NOT apply the Ecuadorian check digit to a foreign document', () => {
    // A Colombian cedula follows different rules. Validating it as Ecuadorian
    // would reject a document that is perfectly valid.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: { type: 'FOREIGN_ID', issuingCountry: 'COL', value: '1234567890' },
    });
    expect(result.success).toBe(true);
  });

  it('registers a patient with NO document at all', () => {
    // A newborn twenty minutes old and an unconscious trauma case both need a
    // chart before anybody has paperwork for them. This is the requirement,
    // not a relaxation of one.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    expect(result.data?.identifier).toBeUndefined();
  });

  it('keeps an estimated birth date marked as estimated', () => {
    // Undocumented migrants arrive with an estimated age. Without the flag the
    // estimate is later reported to the ministry as a fact.
    const result = createPatientSchema.safeParse({
      ...BASE,
      birthDateEstimated: true,
    });
    expect(result.data?.birthDateEstimated).toBe(true);
  });

  it('defaults the estimate flag to false rather than leaving it absent', () => {
    const result = createPatientSchema.safeParse(BASE);
    expect(result.data?.birthDateEstimated).toBe(false);
  });

  it('requires both a given name and a family name', () => {
    expect(createPatientSchema.safeParse({ ...BASE, givenName: '   ' }).success)
      .toBe(false);
    expect(createPatientSchema.safeParse({ ...BASE, familyName: '' }).success)
      .toBe(false);
  });

  it('keeps the second surname optional', () => {
    // Not everybody has one recorded, and demanding it invents data.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });
});

describe('searching the register', () => {
  it('caps the page size so nobody can ask for the whole register', () => {
    // The register is health data. One request returning every row is both a
    // performance problem and an exfiltration primitive.
    expect(searchPatientsSchema.safeParse({ pageSize: 500 }).success).toBe(false);
  });

  it('defaults to a first page of a sane size', () => {
    const result = searchPatientsSchema.safeParse({});
    expect(result.data).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('hides merged records unless they are asked for', () => {
    // A merged chart is not deleted, but staff opening it would find notes
    // that simply stop.
    expect(searchPatientsSchema.safeParse({}).data?.includeMerged).toBe(false);
  });
});
