import { beforeAll, describe, expect, it } from 'vitest';

import { loadInventedCases } from '../cases.ts';
import { type Catalogues, loadCatalogues } from '../catalogue.ts';
import type { Ask } from '../task.ts';

import { searchLikeTheProduct } from './prescription-from-note.ts';
import {
  chartTask,
  prescriptionFieldsTask,
  symptomsTask,
} from './physician-fill.ts';

let catalogues: Catalogues;
let invented: ReturnType<typeof loadInventedCases>;
beforeAll(() => {
  catalogues = loadCatalogues();
  invented = loadInventedCases();
});

const line = (overrides: Record<string, unknown>) => ({
  drug: 'amoxicilina',
  strength: null,
  form: null,
  doseAmount: null,
  doseUnit: null,
  route: null,
  frequency: null,
  frequencyText: null,
  durationDays: null,
  instructions: null,
  quote: '',
  ...overrides,
});

describe('the cases of SC-102 to SC-104 (AS-277)', () => {
  it('AS-277 every set is invented, has the libreto and its three variants, and expects what the cuadro and the CIE-10 have', () => {
    const { prescriptionFields, symptoms, chart } = invented;
    for (const set of [prescriptionFields, symptoms, chart]) {
      expect(set.cases.length).toBeGreaterThanOrEqual(4);
      expect(set.cases.every((item) => item.origin === 'invented')).toBe(true);
      expect(set.cases.some((item) => item.id.includes('libreto'))).toBe(true);
    }
    for (const item of prescriptionFields.cases) {
      for (const expected of item.expected) {
        const medicine = catalogues.cnmb.find((m) => m.code === expected.cnmbCode); // prettier-ignore
        expect(medicine, `${item.id} ${expected.cnmbCode}`).toBeDefined();
        expect(searchLikeTheProduct(medicine!.display, catalogues.cnmb).map((m) => m.code)).toContain(expected.cnmbCode); // prettier-ignore
      }
    }
  });
});

describe('receta-campos (AS-277, SC-102)', () => {
  it('AS-277 the libreto read as the author dictated it: every field right and the deduced ones marked', async () => {
    const item = invented.prescriptionFields.cases.find((each) => each.id === 'receta-campos-libreto')!; // prettier-ignore
    const amoxicillin = searchLikeTheProduct('amoxicilina', catalogues.cnmb);
    const paracetamol = searchLikeTheProduct('paracetamol', catalogues.cnmb);
    const followUp: Ask = () =>
      Promise.resolve({
        choices: [
          { line: 1, medicine: amoxicillin.findIndex((m) => m.code === 'J01CA04') + 1, presentation: null }, // prettier-ignore
          { line: 2, medicine: paracetamol.findIndex((m) => m.code === 'N02BE01') + 1, presentation: null }, // prettier-ignore
        ],
      } as never);

    const result = await prescriptionFieldsTask(catalogues).evaluate(
      item,
      'D',
      {
        lines: [
          line({ strength: '500 mg', form: 'CAPSULE', doseAmount: 1, doseUnit: 'CAPSULE', quote: 'Amoxicilina 500 mg cápsulas, una cápsula cada 8 horas por 7 días' }), // prettier-ignore
          line({ drug: 'paracetamol', quote: 'Paracetamol de 500 cada 8 horas si tiene fiebre o dolor' }), // prettier-ignore
        ],
      },
      null,
      followUp,
    );

    expect(result.scores).toEqual({ fields: 1, wrong: 0, unmarked: 0 });
  });
});

describe('sintomas (AS-277, SC-103)', () => {
  it('AS-277 the libreto’s symptoms become phrases: no R code beside the tonsillitis', async () => {
    const item = invented.symptoms.cases.find((each) => each.id === 'sintomas-libreto')!; // prettier-ignore
    const codes: Record<string, string[]> = { 'AMIGDALITIS AGUDA': ['J03.9', 'J02.9'], FIEBRE: ['R50.9'] }; // prettier-ignore
    const followUp: Ask = (request) =>
      Promise.resolve({ codes: codes[/«(.+)»/.exec(request.prompt)?.[1] ?? ''] ?? [] } as never); // prettier-ignore

    const result = await symptomsTask(catalogues).evaluate(
      item,
      'D',
      {
        problems: [
          { problem: 'AMIGDALITIS AGUDA', quote: 'placas blancas en las amígdalas' }, // prettier-ignore
          { problem: 'FIEBRE', quote: 'con fiebre desde ayer de hasta 38,5 °C' }, // prettier-ignore
        ],
      },
      null,
      followUp,
    );

    expect(result.scores).toEqual({ symptomCodes: 0, diagnosis: 1, symptomProblems: 1 }); // prettier-ignore
  });
});

describe('ficha (AS-277, SC-104)', () => {
  it('AS-277 the libreto: «sin alergias» and the mother’s hypertension found; an entry nobody said counts as invented', async () => {
    const item = invented.chart.cases.find((each) => each.id === 'ficha-libreto')!; // prettier-ignore

    const result = await chartTask().evaluate(
      item,
      'D',
      {
        noKnownAllergies: { source: 'L6' },
        allergies: [],
        history: [
          { kind: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', source: 'L8' }, // prettier-ignore
          { kind: 'PERSONAL', description: 'Amigdalitis aguda', relative: null, source: 'L9' }, // prettier-ignore
        ],
      },
      null,
    );

    expect(result.scores).toEqual({ recall: 1, invented: 1 });
  });
});
