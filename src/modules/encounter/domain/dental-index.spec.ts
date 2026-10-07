import { describe, expect, it } from 'vitest';

import { dentalIndexForAge, dentalIndexOf } from './dental-index';

/**
 * EN-052 (D-160). Which index an attention takes, from its specialty and its
 * FROZEN age. The database applies the same bands
 * (`trg_encounter_dental_index_applies`) and is tested against PostgreSQL in
 * `test/integration/encounter-dental-index.spec.ts`.
 */
const age = (ageYears: number, ageMonths = 0, ageDays = 0) => ({
  ageYears,
  ageMonths,
  ageDays,
});

describe('EN-052 el índice odontológico de la atención', () => {
  it('EN-052 el CEO-D con más de 6 meses y menos de 11 años', () => {
    expect(dentalIndexForAge(age(0, 6, 1))).toBe('CEO_D');
    expect(dentalIndexForAge(age(0, 7))).toBe('CEO_D');
    expect(dentalIndexForAge(age(1))).toBe('CEO_D');
    expect(dentalIndexForAge(age(10, 11, 30))).toBe('CEO_D');
  });

  it('EN-052 el CPO-D desde los 12 años', () => {
    expect(dentalIndexForAge(age(12))).toBe('CPO_D');
    expect(dentalIndexForAge(age(80, 3, 2))).toBe('CPO_D');
  });

  it('EN-052 D-160 ninguno a los 11 años, con 6 meses o menos, ni sin edad congelada', () => {
    expect(dentalIndexForAge(age(11))).toBeNull();
    expect(dentalIndexForAge(age(11, 11, 30))).toBeNull();
    expect(dentalIndexForAge(age(0, 6, 0))).toBeNull();
    expect(dentalIndexForAge(age(0, 0, 3))).toBeNull();
    expect(
      dentalIndexForAge({ ageYears: null, ageMonths: null, ageDays: null }),
    ).toBeNull();
  });

  it('EN-052 D-160 sólo odontología lleva índice', () => {
    expect(dentalIndexOf('odontologia', age(8))).toBe('CEO_D');
    expect(dentalIndexOf('odontologia', age(30))).toBe('CPO_D');
    expect(dentalIndexOf('pediatria', age(8))).toBeNull();
    expect(dentalIndexOf(null, age(30))).toBeNull();
  });
});
