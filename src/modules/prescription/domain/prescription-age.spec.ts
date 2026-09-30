import { describe, expect, it } from 'vitest';

import { prescriptionAgeOf } from './prescription-age';

/**
 * PR-025. «Para el caso de menores de cinco (5) años, la edad se especificará
 * en años y meses» — art. 5.b.ii.
 *
 * The boundary is the whole test: four years eleven months carries months and
 * five years exactly does not. A paediatric dose is milligrams per kilogram and
 * the weight of a child is a function of the month, so the field the norm asks
 * for is the one that changes the medicine.
 */
describe('la edad en la receta', () => {
  it('PR-025 expresa en años y meses la edad de un menor de cinco años', () => {
    expect(prescriptionAgeOf({ years: 1, months: 2, days: 5 })).toEqual({
      years: 1,
      months: 2,
      text: '1 año 2 meses',
    });
  });

  it('PR-025 deja de dar los meses justo a los cinco años', () => {
    expect(prescriptionAgeOf({ years: 4, months: 11, days: 30 })).toEqual({
      years: 4,
      months: 11,
      text: '4 años 11 meses',
    });
    expect(prescriptionAgeOf({ years: 5, months: 0, days: 0 })).toEqual({
      years: 5,
      months: null,
      text: '5 años',
    });
  });

  it('PR-025 da sólo los meses al lactante, porque «0 años» no dice nada', () => {
    expect(prescriptionAgeOf({ years: 0, months: 2, days: 10 })?.text).toBe(
      '2 meses',
    );
    expect(prescriptionAgeOf({ years: 0, months: 1, days: 0 })?.text).toBe(
      '1 mes',
    );
    expect(prescriptionAgeOf({ years: 0, months: 0, days: 6 })?.text).toBe(
      '0 meses',
    );
  });

  it('PR-025 concuerda el singular y el plural', () => {
    expect(prescriptionAgeOf({ years: 1, months: 1, days: 0 })?.text).toBe(
      '1 año 1 mes',
    );
    expect(
      prescriptionAgeOf({ years: 34, months: null, days: null })?.text,
    ).toBe(
      // prettier-ignore
      '34 años',
    );
  });

  it('PR-025 no inventa una edad cuando la atención no la congeló', () => {
    // `trg_encounter_freeze_age` la escribe en todo `INSERT`, así que esto no
    // puede ocurrirle a una fila de este sistema. Devolver `null` en vez de
    // «0 años» es la diferencia entre un hueco que alguien ve y un documento
    // que afirma algo que nadie registró.
    expect(prescriptionAgeOf({ years: null, months: null, days: null })).toBeNull(); // prettier-ignore
  });

  it('PR-025 trata como cero los meses ausentes de un menor de cinco', () => {
    expect(prescriptionAgeOf({ years: 2, months: null, days: null })).toEqual({
      years: 2,
      months: 0,
      text: '2 años 0 meses',
    });
  });
});
