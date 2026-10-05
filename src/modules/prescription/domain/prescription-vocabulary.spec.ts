import { describe, expect, it } from 'vitest';

import {
  DOSAGE_FORMS,
  DOSE_UNITS,
  FREQUENCIES,
  doseText,
  frequencyText,
  isDeclaredPresentation,
} from './prescription-vocabulary';

describe('el vocabulario de la línea de receta (PR-101 a PR-104)', () => {
  it('PR-101 compone la dosis con el número y la unidad, en singular sólo para uno', () => {
    expect(doseText(1, 'TABLET')).toBe('1 tableta');
    expect(doseText(2, 'TABLET')).toBe('2 tabletas');
    expect(doseText(2.5, 'MILLILITRE')).toBe('2,5 mililitros');
    expect(doseText(0.5, 'TABLET')).toBe('0,5 tabletas');
  });

  it('PR-101 ninguna forma ni unidad es una sigla: art. 13', () => {
    const printed = [
      ...Object.values(DOSAGE_FORMS).map((form) => form.label),
      ...Object.values(DOSE_UNITS).flatMap((unit) => [unit.one, unit.many]),
      ...Object.values(FREQUENCIES),
    ];
    for (const text of printed) {
      expect(text, text).not.toMatch(/\b[A-Z]{2,}\b|\./);
      expect(text, text).not.toMatch(/\b(tab|comp|caps|ml|mg|ui|vo)\b/i);
    }
  });

  it('PR-103 una forma propone unidad sólo si la implica sin duda; nunca un líquido ni un inyectable', () => {
    for (const form of Object.values(DOSAGE_FORMS)) {
      if (form.unit !== null) expect(DOSE_UNITS[form.unit]).toBeDefined();
    }
    expect(DOSAGE_FORMS.TABLET.unit).toBe('TABLET');
    expect(DOSAGE_FORMS.ORAL_SUSPENSION.unit).toBeNull();
    expect(DOSAGE_FORMS.INJECTABLE_SOLUTION.unit).toBeNull();
  });

  it('PR-102 la frecuencia es la frase de la lista o lo escrito, nunca las dos', () => {
    expect(frequencyText('EVERY_8_HOURS', null)).toBe('Cada 8 horas');
    expect(frequencyText(null, '  después de cada deposición ')).toBe(
      'después de cada deposición',
    );
  });

  it('PR-104 una presentación declarada se reconoce sin importar mayúsculas ni espacios', () => {
    const declared = [{ form: 'TABLET', concentration: '10 mg' }];

    expect(isDeclaredPresentation(declared, 'TABLET', '10mg')).toBe(true);
    expect(
      isDeclaredPresentation(
        [{ form: 'SYRUP', concentration: '62,5 µg/ml' }],
        'SYRUP',
        '62.5 mcg/ml',
      ),
    ).toBe(true);
    expect(isDeclaredPresentation(declared, 'TABLET', '500 mg')).toBe(false);
    expect(isDeclaredPresentation(declared, 'CAPSULE', '10 mg')).toBe(false);
  });

  it('PR-104 un concepto que no declara presentaciones admite cualquiera', () => {
    expect(isDeclaredPresentation([], 'TABLET', '500 mg')).toBe(true);
  });
});
