import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORRECTABLE_PATIENT_FIELDS,
  type PatientCorrectionSnapshot,
  correctionTextOf,
  isCorrectablePatientField,
  planCorrection,
} from './patient-corrections';

const MOTHER = '00000000-0000-4000-8000-000000000001';
const PARISH = '00000000-0000-4000-8000-000000000002';

const CURRENT: PatientCorrectionSnapshot = {
  familyName: 'Guamán',
  secondFamilyName: null,
  givenName: 'Maria',
  secondGivenName: null,
  sex: 'FEMALE',
  birthDate: '1990-04-12',
  birthDateEstimated: 'false',
  deceasedAt: null,
  phone: null,
  email: null,
  residenceAddressLine: null,
  bloodType: null,
  ethnicityConceptId: null,
  nationalityConceptId: null,
  peopleConceptId: null,
  sexualOrientationConceptId: null,
  residenceParishConceptId: null,
  genderIdentityConceptId: null,
  countryOfNationalityCode: null,
  motherPatientId: null,
  employerName: null,
  jobTitle: null,
};

describe('planning a correction of a chart', () => {
  it('PA-031 records the value a corrected field held before', () => {
    // A surname mistyped at the desk was permanent until this route existed,
    // which also made the right of rectification impossible (REQ-113).
    expect(planCorrection(CURRENT, { givenName: 'María' })).toEqual([
      { field: 'givenName', valueBefore: 'Maria', valueAfter: 'María' },
    ]);
  });

  it('PA-031 leaves a field that was not sent completely alone', () => {
    // Absent is not "clear it". The desk corrects the letter it just saw
    // wrong, and everything else has to survive the request untouched.
    const changes = planCorrection(CURRENT, { givenName: 'María' });
    expect(changes.map((change) => change.field)).toEqual(['givenName']);
  });

  it('PA-031 treats an explicit null as clearing the field', () => {
    expect(
      planCorrection({ ...CURRENT, phone: '0991234567' }, { phone: null }),
    ).toEqual([
      { field: 'phone', valueBefore: '0991234567', valueAfter: null },
    ]);
  });

  it('PA-031 writes no row for a field re-sent with the value it already had', () => {
    // `patient_change_history_value_changed` would refuse such a row, and it
    // is right to: a trail entry showing the same value on both sides buries
    // the change somebody is looking for.
    expect(planCorrection(CURRENT, { familyName: 'Guamán' })).toEqual([]);
  });

  it('PA-031 keeps the trail in the order of the field list, not of the request', () => {
    // Two callers sending the same correction leave the same trail.
    const changes = planCorrection(CURRENT, {
      motherPatientId: MOTHER,
      givenName: 'María',
      residenceParishConceptId: PARISH,
    });

    expect(changes.map((change) => change.field)).toEqual([
      'givenName',
      'residenceParishConceptId',
      'motherPatientId',
    ]);
  });

  it('PA-008 stores a date of death as the instant it begins in Ecuador', () => {
    // A date is what the desk knows; the column is a `timestamptz`. Midnight
    // UTC would be 19:00 of the day before here — a death recorded one day
    // early, and before the birth for anyone who dies on the day they are born.
    expect(planCorrection(CURRENT, { deceasedAt: '2026-03-03' })).toEqual([
      {
        field: 'deceasedAt',
        valueBefore: null,
        valueAfter: '2026-03-03T05:00:00.000Z',
      },
    ]);
  });

  it('PA-008 sees no change when the date of death re-sent is the one stored', () => {
    // The stored instant and the incoming date are compared through the SAME
    // formatting rule. Two rules would report a change on every re-send.
    const stored = {
      ...CURRENT,
      deceasedAt: '2026-03-03T05:00:00.000Z',
    };
    expect(planCorrection(stored, { deceasedAt: '2026-03-03' })).toEqual([]);
  });

  it('PA-009 records the link to the mother as the uuid it is', () => {
    expect(planCorrection(CURRENT, { motherPatientId: MOTHER })).toEqual([
      { field: 'motherPatientId', valueBefore: null, valueAfter: MOTHER },
    ]);
  });

  it('PA-031 writes the estimated-birth-date flag as a value, not as a presence', () => {
    // `false` is a value, and `correctionTextOf` must not fold it into "no
    // value" — a chart whose estimate was corrected to a fact would then leave
    // no trail of having been an estimate.
    expect(correctionTextOf('birthDateEstimated', false)).toBe('false');
    expect(correctionTextOf('birthDateEstimated', true)).toBe('true');
  });

  it('PA-031 admits exactly the fields the database CHECK admits', () => {
    /**
     * The list is repeated in the migrations, on purpose — an import never
     * passes through this file. What must never happen is the two disagreeing,
     * so the SQL is read here rather than trusted.
     *
     * ⚠️ THE LAST MIGRATION THAT DEFINES THE CHECK IS THE ONE THAT COUNTS, and
     * that is why every migration is scanned instead of the one that created
     * it. An applied constraint is never edited in yesterday's file: it is
     * dropped and recreated in a new one, so reading only
     * `_patient_record_corrections` would compare the domain against a list two
     * fields out of date and fail for the wrong reason.
     */
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    const clauses = readdirSync(migrations)
      .sort()
      .flatMap((name) => {
        let sql: string;
        try {
          sql = readFileSync(join(migrations, name, 'migration.sql'), 'utf8');
        } catch {
          return [];
        }
        return [
          ...sql.matchAll(
            /patient_change_history_field_known"?\s*CHECK\s*\("field" IN \(([^)]*)\)/g,
          ),
        ].map((match) => match[1] ?? '');
      });
    expect(clauses.length, 'the CHECK clause').toBeGreaterThan(0);

    const inDatabase = [...(clauses.at(-1) ?? '').matchAll(/'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(inDatabase).toEqual([...CORRECTABLE_PATIENT_FIELDS]);
  });

  it('PA-061 corrects the employer and the job title like any other datum, with their previous value', () => {
    expect(
      planCorrection(
        { ...CURRENT, employerName: 'Textiles Andinos' },
        { employerName: 'Florícola del Valle', jobTitle: 'Supervisora' },
      ),
    ).toEqual([
      {
        field: 'employerName',
        valueBefore: 'Textiles Andinos',
        valueAfter: 'Florícola del Valle',
      },
      { field: 'jobTitle', valueBefore: null, valueAfter: 'Supervisora' },
    ]);
  });

  it('PA-053 records the country of nationality as the alpha-3 code it is', () => {
    /**
     * Se guarda el CÓDIGO y no una referencia a un concepto, igual que
     * `patient_identifier.issuing_country`: dos representaciones del país en la
     * misma base acaban discrepando. El rastro guarda lo mismo que la columna,
     * así que el valor anterior de una corrección es legible sin resolver nada.
     */
    expect(
      planCorrection(CURRENT, { countryOfNationalityCode: 'VEN' }),
    ).toEqual([
      {
        field: 'countryOfNationalityCode',
        valueBefore: null,
        valueAfter: 'VEN',
      },
    ]);
  });

  it('PA-002 does NOT admit the medical record number as a correctable field', () => {
    // The MRN is the identity anchor and never changes: a trail row saying it
    // did would be a record of something the system does not permit.
    expect(isCorrectablePatientField('mrn')).toBe(false);
    expect(isCorrectablePatientField('isProvisional')).toBe(false);
    expect(isCorrectablePatientField('familyName')).toBe(true);
  });
});
