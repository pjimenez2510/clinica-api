import { describe, expect, it } from 'vitest';

import { BmiIsDerivedError, VitalsRequiredError } from './encounter.errors';
import {
  assertBmiNotSupplied,
  assertMandatoryAnthropometry,
  isUnderFive,
} from './vital-signs';

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

const NEWBORN = { years: 0, months: 0, days: 12 };
const TODDLER = { years: 4, months: 11, days: 29 };
const SCHOOLCHILD = { years: 5, months: 0, days: 0 };
const ADULT = { years: 36, months: 2, days: 4 };

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

  it('EN-063 evalúa la obligatoriedad con la edad CONGELADA de la atención', () => {
    // EN-008: what was true THAT DAY. A child of 4 attended in March stays 4
    // in March's row for ever, and evaluating against today would make a
    // report reprocessed next year refuse rows it accepted (PA-005).
    expect(isUnderFive(NEWBORN)).toBe(true);
    expect(isUnderFive(TODDLER)).toBe(true);
    expect(isUnderFive(SCHOOLCHILD)).toBe(false);
    expect(isUnderFive(ADULT)).toBe(false);
  });

  it('EN-063 exige peso, talla y perímetro cefálico en un menor de 5 años', () => {
    try {
      assertMandatoryAnthropometry({ weightKg: 3.4 }, NEWBORN);
      expect.unreachable('la antropometría obligatoria debía exigirse');
    } catch (error) {
      expect(error).toBeInstanceOf(VitalsRequiredError);
      const refusal = error as VitalsRequiredError;
      expect(refusal.code).toBe('VITALS_REQUIRED');
      // ALL the missing fields at once: a nurse correcting a form one refusal
      // at a time is a nurse who stops reading them.
      expect(refusal.fieldErrors?.map((field) => field.field)).toEqual([
        'heightCm',
        'headCircumferenceCm',
      ]);
    }
  });

  it('EN-063 acepta un menor de 5 años con las tres medidas', () => {
    expect(() =>
      assertMandatoryAnthropometry(
        { weightKg: 3.4, heightCm: 50, headCircumferenceCm: 34.5 },
        NEWBORN,
      ),
    ).not.toThrow();
  });

  it('EN-063 deja opcional la antropometría para el resto de pacientes', () => {
    // Literal from the instructivo (p. 44): «para el resto de usuarios el
    // registro es opcional». A required field here would refuse the ordinary
    // adult consultation.
    expect(() => assertMandatoryAnthropometry({}, ADULT)).not.toThrow();
    expect(() => assertMandatoryAnthropometry({}, SCHOOLCHILD)).not.toThrow();
  });

  it('EN-063 no exige nada cuando la atención no tiene edad congelada', () => {
    // Cannot happen on a stored row — `trg_encounter_freeze_age` is
    // `BEFORE INSERT` and fills all three — and the honest failure of an
    // unknown age is to demand nothing rather than everything.
    expect(() =>
      assertMandatoryAnthropometry(
        {},
        { years: null, months: null, days: null },
      ),
    ).not.toThrow();
  });
});
