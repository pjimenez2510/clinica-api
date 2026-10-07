import { describe, expect, it } from 'vitest';

import {
  DOSAGE_FORMS,
  DOSE_UNITS,
  FREQUENCIES,
  doseText,
  frequencyText,
  isDeclaredPresentation,
  matchingPresentations,
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

  it('PR-115 una presentación del cuadro admite cualquiera de sus formas, con la misma concentración', () => {
    const solidOral = [
      {
        form: 'TABLET',
        forms: ['TABLET', 'COATED_TABLET', 'CHEWABLE_TABLET', 'CAPSULE'],
        label: 'Sólido oral',
        concentration: '500 mg',
      },
    ];

    expect(isDeclaredPresentation(solidOral, 'CAPSULE', '500 mg')).toBe(true);
    expect(isDeclaredPresentation(solidOral, 'TABLET', '500 mg')).toBe(true);
    expect(isDeclaredPresentation(solidOral, 'CAPSULE', '750 mg')).toBe(false);
    expect(isDeclaredPresentation(solidOral, 'SYRUP', '500 mg')).toBe(false);
  });

  it('PR-115 una forma del cuadro sin equivalente en la receta no admite ninguna', () => {
    const implant = [
      { form: '', forms: [], label: 'Sólido parenteral (implante subdérmico)', concentration: '68 mg' }, // prettier-ignore
    ];

    expect(isDeclaredPresentation(implant, 'TABLET', '68 mg')).toBe(false);
    expect(isDeclaredPresentation(implant, '', '68 mg')).toBe(false);
  });

  it('PR-115 una concentración dentro del rango que el cuadro declara, con su unidad, está en el cuadro', () => {
    const metformin = [
      { form: 'TABLET', forms: ['TABLET'], label: 'Sólido oral', concentration: '500 mg - 1000 mg' }, // prettier-ignore
    ];
    const penicillin = [
      { form: 'POWDER_FOR_INJECTION', forms: ['POWDER_FOR_INJECTION'], label: 'Sólido parenteral', concentration: "600.000 UI - 2'400.000 UI" }, // prettier-ignore
    ];

    expect(isDeclaredPresentation(metformin, 'TABLET', '850 mg')).toBe(true);
    expect(isDeclaredPresentation(metformin, 'TABLET', '1000mg')).toBe(true);
    expect(isDeclaredPresentation(metformin, 'TABLET', '1,5 g')).toBe(false);
    expect(isDeclaredPresentation(metformin, 'TABLET', '1500 mg')).toBe(false);
    expect(isDeclaredPresentation(metformin, 'TABLET', '500 mg - 1000 mg')).toBe(false); // prettier-ignore
    expect(isDeclaredPresentation(penicillin, 'POWDER_FOR_INJECTION', '1.200.000 UI')).toBe(true); // prettier-ignore
  });

  it('PR-115 una composición descrita en texto, que no es una cifra, sólo exige la forma', () => {
    const oralRehydration = [
      { form: 'POWDER_FOR_ORAL_SUSPENSION', forms: ['POWDER_FOR_ORAL_SUSPENSION'], label: 'Sólido oral (polvo)', concentration: 'Glucosa 13,5 g/L - 20 g/L Cloruro de Sodio 2,6 g/L - 3,5 g/L Cloruro de Potasio 1,5 g/L Citrato trisódico dihidrato 2,9 g/L' }, // prettier-ignore
    ];

    expect(isDeclaredPresentation(oralRehydration, 'POWDER_FOR_ORAL_SUSPENSION', '20,5 g')).toBe(true); // prettier-ignore
    expect(isDeclaredPresentation(oralRehydration, 'TABLET', '20,5 g')).toBe(false); // prettier-ignore
  });

  it('PR-115 la línea sabe qué presentación del cuadro es, y con ella su DCI', () => {
    const haloperidol = [
      { form: 'INJECTABLE_SOLUTION', forms: ['INJECTABLE_SOLUTION'], label: 'Líquido parenteral', concentration: '5 mg/mL', dci: 'Haloperidol' }, // prettier-ignore
      { form: 'INJECTABLE_SOLUTION', forms: ['INJECTABLE_SOLUTION'], label: 'Líquido parenteral', concentration: '50 mg/mL', dci: 'Haloperidol decanoato' }, // prettier-ignore
    ];

    expect(
      matchingPresentations(haloperidol, 'INJECTABLE_SOLUTION', '50 mg/mL').map((p) => p.dci), // prettier-ignore
    ).toEqual(['Haloperidol decanoato']);
    expect(matchingPresentations(haloperidol, 'TABLET', '50 mg/mL')).toEqual(
      [],
    );
  });

  it('PR-115 la receta nombra las formas que el cuadro distingue: liberación prolongada, sublingual, lipídica', () => {
    expect(DOSAGE_FORMS.EXTENDED_RELEASE_TABLET.label).toBe('Tableta de liberación prolongada'); // prettier-ignore
    expect(DOSAGE_FORMS.SUBLINGUAL_TABLET.label).toBe('Tableta sublingual');
    expect(DOSAGE_FORMS.LIPID_POWDER_FOR_INJECTION.label).toBe('Polvo para solución inyectable, formulación lipídica'); // prettier-ignore
  });

  it('PR-115 todo código de forma cabe en su columna (prescription_item.dosage_form_code, 32)', () => {
    for (const code of Object.keys(DOSAGE_FORMS))
      expect(code.length, code).toBeLessThanOrEqual(32);
  });

  it('PR-115 un rango sin unidad en el extremo bajo, el aparte de la enoxaparina, una combinación y el guion', () => {
    const at = (concentration: string) => [
      {
        form: 'TABLET',
        forms: ['TABLET'],
        label: 'Sólido oral',
        concentration,
      },
    ];

    // «25 - 50 mg/5 mL»: la unidad del extremo alto vale para los dos.
    const iron = at('25 - 50 mg/5 mL (equivalente a hierro elemental)');
    expect(isDeclaredPresentation(iron, 'TABLET', '25 mg/5 mL')).toBe(true);
    expect(isDeclaredPresentation(iron, 'TABLET', '25 - 50 mg/5 mL (equivalente a hierro elemental)')).toBe(false); // prettier-ignore
    // El aparte de un rango también es un rango: la enoxaparina en mg.
    const enoxaparin = at('2000 UI - 10.000 UI (20 mg - 100 mg)');
    expect(isDeclaredPresentation(enoxaparin, 'TABLET', '40 mg')).toBe(true);
    expect(isDeclaredPresentation(enoxaparin, 'TABLET', '4000 UI')).toBe(true);
    expect(isDeclaredPresentation(enoxaparin, 'TABLET', '200 mg')).toBe(false);
    // Una combinación con un rango que no se puede leer: ni copiada vale.
    const salmeterol = at('25 mcg + (50 mcg - 250 mcg)');
    expect(isDeclaredPresentation(salmeterol, 'TABLET', '25 mcg + (50 mcg - 250 mcg)')).toBe(false); // prettier-ignore
    expect(isDeclaredPresentation(salmeterol, 'TABLET', '50 mcg')).toBe(false);
    // «-»: el cuadro no declara concentración; sólo cuenta la forma.
    expect(isDeclaredPresentation(at('-'), 'TABLET', '5 g')).toBe(true);
    expect(isDeclaredPresentation(at('-'), 'SYRUP', '5 g')).toBe(false);
  });
});
