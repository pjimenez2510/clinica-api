import { beforeAll, describe, expect, it } from 'vitest';

import { loadInventedCases, type PrescriptionNoteCase } from '../cases.ts';
import { type Catalogues, loadCatalogues } from '../catalogue.ts';
import type { Ask } from '../task.ts';

import {
  prescriptionFromNoteTask,
  searchLikeTheProduct,
} from './prescription-from-note.ts';

let catalogues: Catalogues;
let cases: PrescriptionNoteCase[];
beforeAll(() => {
  catalogues = loadCatalogues();
  cases = loadInventedCases().prescriptionNote.cases;
});

const line = (drug: string, strength: string | null, quote: string) => ({
  drug,
  strength,
  form: null,
  doseAmount: null,
  doseUnit: null,
  route: null,
  frequency: null,
  frequencyText: null,
  durationDays: null,
  instructions: null,
  quote,
});

/** The provider asked again, answering what the test says. */
const answering =
  (
    choices: {
      line: number;
      medicine: number | null;
      presentation: number | null;
    }[],
  ): Ask =>
  // prettier-ignore
  () =>
    Promise.resolve({ choices } as never);

describe('receta-nota task (AS-079)', () => {
  it('AS-079 every invented note expects medicines and concentrations the cuadro has, and the product’s search reaches them', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const item of cases) {
      expect(item.origin).toBe('invented');
      for (const expected of item.expected) {
        const medicine = catalogues.cnmb.find((m) => m.code === expected.cnmbCode); // prettier-ignore
        expect(medicine, `${item.id} ${expected.cnmbCode}`).toBeDefined();
        const word = medicine!.display.split(/[\s+]/)[0]!;
        expect(searchLikeTheProduct(word, catalogues.cnmb).map((m) => m.code), item.id).toContain(expected.cnmbCode); // prettier-ignore
      }
    }
  });

  it('AS-064 searches like the product: no accents nor case, the exact name first, at most five', () => {
    const found = searchLikeTheProduct('AMOXICILÍNA', catalogues.cnmb);
    expect(found[0]?.code).toBe('J01CA04');
    expect(found.map((m) => m.code)).toContain('J01CR02');
    expect(searchLikeTheProduct('metronidazol', catalogues.cnmb).length).toBeLessThanOrEqual(5); // prettier-ignore
    expect(searchLikeTheProduct('naproxeno', catalogues.cnmb)).toEqual([]);
  });

  it('AS-079 a line mapped to the right medicine and presentation counts; the wrong presentation does not', async () => {
    const task = prescriptionFromNoteTask(catalogues);
    const item = cases.find((c) => c.id === 'receta-nota-01')!;
    const read = { lines: [line('Amoxicilina', '500 mg', 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días')] }; // prettier-ignore

    // J01CA04's presentation 1 is the tablet of 500 mg.
    const right = await task.evaluate(item, 'D', read, null, answering([{ line: 1, medicine: 1, presentation: 1 }])); // prettier-ignore
    expect(right.scores).toMatchObject({ mapping: 1, medicine: 1, all: 1, extra: 0, outsideCnmb: 0 }); // prettier-ignore

    // The suspension contradicts «500 mg»: no presentation (AS-066), not right.
    const wrong = await task.evaluate(item, 'D', read, null, answering([{ line: 1, medicine: 1, presentation: 2 }])); // prettier-ignore
    expect(wrong.scores).toMatchObject({ mapping: 0, medicine: 1 });
  });

  it('AS-065 AS-079 a number the model was not offered shows nothing, and nothing outside the cuadro is ever shown', async () => {
    const task = prescriptionFromNoteTask(catalogues);
    const item = cases.find((c) => c.id === 'receta-nota-01')!;
    const read = { lines: [line('Amoxicilina', '500 mg', 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días')] }; // prettier-ignore

    const { shown, scores } = await task.evaluate(item, 'D', read, null, answering([{ line: 1, medicine: 9, presentation: 1 }])); // prettier-ignore
    expect(shown).toEqual([]);
    expect(scores).toMatchObject({ mapping: 0, outsideCnmb: 0 });
  });

  it('AS-079 a distractor note expects nothing: what it shows counts as extra', async () => {
    const task = prescriptionFromNoteTask(catalogues);
    const item = cases.find((c) => c.id === 'receta-nota-33')!; // naproxeno
    const nothing = await task.evaluate(item, 'D', { lines: [line('Naproxeno', '550 mg', 'Naproxeno 550 mg, una tableta cada 12 horas por 5 días')] }, null, answering([])); // prettier-ignore
    expect(nothing.scores).toMatchObject({ mapping: null, all: 1, extra: 0 });
  });

  it('AS-066 a strength the cuadro does not have is right only shown without a presentation', async () => {
    const task = prescriptionFromNoteTask(catalogues);
    const item = cases.find((c) => c.id === 'receta-nota-39')!; // paracetamol 1 g
    const paracetamol = catalogues.cnmb.find((m) => m.code === 'N02BE01')!;
    const tablet = paracetamol.presentations.findIndex((p) => p.form === 'TABLET') + 1; // prettier-ignore

    const { scores } = await task.evaluate(item, 'D', { lines: [line('Paracetamol', '1 g', 'Paracetamol 1 g, cada 8 horas por 2 días')] }, null, answering([{ line: 1, medicine: 1, presentation: tablet }])); // prettier-ignore
    expect(scores).toMatchObject({ mapping: 1 });
  });

  it('AS-063 a line whose phrase is not in the note is dropped before anything is searched', async () => {
    const task = prescriptionFromNoteTask(catalogues);
    const item = cases.find((c) => c.id === 'receta-nota-01')!;
    let asked = false;
    const { shown } = await task.evaluate(item, 'D', { lines: [line('Amoxicilina', '500 mg', 'Amoxicilina 875 mg cada 12 horas')] }, null, () => { asked = true; return Promise.resolve(null); }); // prettier-ignore
    expect(shown).toEqual([]);
    expect(asked).toBe(false);
  });
});
