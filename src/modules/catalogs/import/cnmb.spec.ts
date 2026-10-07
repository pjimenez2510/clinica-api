import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONTROLLED_CODES,
  DEVELOPMENT_CODES,
  readCnmb,
  vocabularyFormsOf,
} from './cnmb';
import { readWorkbook } from './xlsx';

const cuadro = () =>
  readCnmb(
    readWorkbook(
      readFileSync(
        resolve(__dirname, '../../../../prisma/catalogs/cnmb-2026.xlsx'),
      ),
    )[0]!,
  );

describe('the CNMB 2026 (PR-114 to PR-116)', () => {
  it('PR-116: one medicine per «Código medicamento», with its presentations', () => {
    const medicines = cuadro();

    expect(medicines).toHaveLength(528);
    expect(
      medicines.reduce((n, medicine) => n + medicine.presentations.length, 0),
    ).toBe(889); // 890 rows, one of them repeated verbatim
    const amoxicillin = medicines.find((m) => m.code === 'J01CA04');
    expect(amoxicillin).toMatchObject({
      display: 'Amoxicilina',
      atc: 'J01CA',
      controlled: false,
      replaces: ['AMOXICILINA'],
    });
    expect(amoxicillin?.presentations[0]).toMatchObject({
      label: 'Sólido oral',
      concentration: '500 mg',
      form: 'TABLET',
      forms: ['TABLET', 'COATED_TABLET', 'CHEWABLE_TABLET', 'CAPSULE'],
      route: 'O - Oral',
    });
  });

  it('PR-116: names a code that carries several DCI without losing any of them', () => {
    const byCode = new Map(cuadro().map((m) => [m.code, m]));

    // A spelling variant is one name, the accented one.
    expect(byCode.get('A04AA01')?.display).toBe('Ondansetrón');
    // One DCI that begins the others is the name; each row keeps its own.
    const haloperidol = byCode.get('N05AD01')!;
    expect(haloperidol.display).toBe('Haloperidol');
    expect(haloperidol.presentations.map((p) => p.dci)).toContain(
      'Haloperidol decanoato',
    );
    // Two products under one code: the name says both.
    expect(byCode.get('B02BD04')?.display).toBe(
      'Factor de coagulación IX plasmático / Factor de coagulación IX recombinante',
    );
  });

  it('PR-116: marks as controlled exactly the codes of D-148, all of which are in the cuadro', () => {
    const medicines = cuadro();
    const controlled = medicines.filter((m) => m.controlled).map((m) => m.code);

    expect(new Set(controlled)).toEqual(CONTROLLED_CODES);
    expect(medicines.find((m) => m.code === 'N02AA01')?.controlled).toBe(true);
    // D-148.2: tramadol is marked until a pharmacist rules; paracetamol is not.
    expect(medicines.find((m) => m.code === 'N02AX02')?.controlled).toBe(true);
    expect(medicines.find((m) => m.code === 'N02BE01')?.controlled).toBe(false);
  });

  it('PR-114: every development code has a successor that exists in the cuadro', () => {
    const codes = new Set(cuadro().map((m) => m.code));

    for (const successor of Object.values(DEVELOPMENT_CODES))
      expect(codes).toContain(successor);
  });

  it('PR-115: maps the forms of the cuadro onto the prescription vocabulary', () => {
    expect(vocabularyFormsOf('Sólido oral (polvo)', 'O - Oral')).toEqual([
      'POWDER_FOR_ORAL_SUSPENSION',
    ]);
    expect(vocabularyFormsOf('Líquido para inhalación', 'N - Nasal')).toEqual([
      'NASAL_SPRAY',
    ]);
    expect(
      vocabularyFormsOf('Líquido parenteral', 'P (IV) - Parenteral'),
    ).toEqual(['INJECTABLE_SOLUTION']);
    // No counterpart on a receta: nothing is admitted, and the line is outside.
    expect(
      vocabularyFormsOf('Líquido intratraqueal', 'IT - Intratraqueal'),
    ).toEqual([]);
    // A qualified form maps to its own, never to the plain one (PR-115).
    expect(vocabularyFormsOf('Sólido oral (liberación prolongada)', 'O - Oral')).toEqual(['EXTENDED_RELEASE_TABLET']); // prettier-ignore
    expect(vocabularyFormsOf('Sólido oral sublingual', 'O - Oral')).toEqual(['SUBLINGUAL_TABLET']); // prettier-ignore
    expect(vocabularyFormsOf('Sólido parenteral (formas lipídicas)', 'P - Parenteral')).toEqual(['LIPID_POWDER_FOR_INJECTION']); // prettier-ignore
    expect(vocabularyFormsOf('Sólido parenteral (implante subdérmico)', 'P - Parenteral')).toEqual(['SUBDERMAL_IMPLANT']); // prettier-ignore
  });

  it('PR-116: refuses a file whose columns moved, rather than reading the wrong one', () => {
    expect(() =>
      readCnmb({ name: 'Medicamentos', rows: [['Codigo ATC', 'DCI']] }),
    ).toThrow(/Codigo medicamento/);
  });

  it('PR-114: the same active substance under two codes carries the same key', () => {
    const byCode = new Map(cuadro().map((m) => [m.code, m]));

    expect(byCode.get('B01AC06')?.substances).toEqual(['dci:acido acetilsalicilico']); // prettier-ignore
    expect(byCode.get('N02BA01')?.substances).toEqual(['dci:acido acetilsalicilico']); // prettier-ignore
    for (const code of ['G01AF01', 'J01XD01', 'P01AB01'])
      expect(byCode.get(code)?.substances).toEqual(['dci:metronidazol']);
    // Two products under one code keep both.
    expect(byCode.get('N05AD01')?.substances).toEqual([
      'dci:haloperidol',
      'dci:haloperidol decanoato',
    ]);
  });

  it('PR-116: names a list of components by its heading, keeping the composition, so it fits the receta (240)', () => {
    const medicines = cuadro();
    const vitaminB = medicines.find((m) => m.code === 'A11DB')!;

    expect(vitaminB.display).toBe('Complejo B');
    expect(vitaminB.presentations[0]?.dci).toBe('Complejo B');
    expect(vitaminB.presentations[0]?.composition).toMatch(
      /^Complejo B: •Tiamina/,
    );
    for (const medicine of medicines) {
      expect(medicine.display.length, medicine.code).toBeLessThanOrEqual(240);
      for (const presentation of medicine.presentations)
        expect(presentation.dci.length, medicine.code).toBeLessThanOrEqual(240);
    }
  });
});
