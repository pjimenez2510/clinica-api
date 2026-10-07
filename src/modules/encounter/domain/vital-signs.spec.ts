import { describe, expect, it } from 'vitest';

import { BmiIsDerivedError } from './encounter.errors';
import { assertBmiNotSupplied } from './vital-signs';

/**
 * Block D — form **020** — as far as pure code can take it.
 *
 * ⚠️ THE TWO GUARANTEES THAT MATTER ARE NOT TESTED HERE AND CANNOT BE: the BMI
 * is written by `trg_encounter_vitals_bmi` and the physiological ranges by
 * `encounter_vitals_ranges_*`. A double that returned what we asked it for would
 * not demonstrate either. They live in `test/integration/encounter-vitals.spec.ts`,
 * against a real PostgreSQL, which is the rule of CLAUDE.md §5 without an
 * exception for convenience.
 */

/*
 * EN-063, EN-217: which anthropometry is demanded and which is still missing
 * is answered by `encounter_anthropometry_required` and
 * `encounter_anthropometry_pending` in the database (one statement for the
 * opening, the taking, the signature and its trigger), and is tested against PostgreSQL in
 * `test/integration/encounter-http.spec.ts`.
 */

describe('los signos vitales', () => {
  it('EN-061 rechaza el IMC enviado en la petición en lugar de descartarlo', () => {
    /**
     * REFUSED AND NOT DROPPED, and that is the whole requirement. The trigger
     * overwrites the column in the same statement, so a supplied value could
     * never be stored — and dropping it silently would leave whoever typed it
     * believing their figure is the one in the record. The day the two differ
     * is the day a nutritional referral is decided on a number nobody wrote.
     */
    try {
      assertBmiNotSupplied({ bmi: 24.7 });
      expect.unreachable('el IMC enviado debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(BmiIsDerivedError);
      const refusal = error as BmiIsDerivedError;
      expect(refusal.code).toBe('BMI_IS_DERIVED');
      expect(refusal.fieldErrors?.[0]?.field).toBe('bmi');
    }
  });

  it('EN-061 rechaza también un IMC nulo, porque nombrarlo ya es tecleárselo', () => {
    // `null` is a value somebody sent; only ABSENCE means «no lo escribí».
    expect(() => assertBmiNotSupplied({ bmi: null })).toThrow(
      BmiIsDerivedError,
    );
  });

  it('EN-061 deja pasar un cuerpo que no nombra el IMC', () => {
    expect(() => assertBmiNotSupplied({})).not.toThrow();
  });
});
