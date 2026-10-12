import { beforeAll, describe, expect, it } from 'vitest';

import { loadInventedCases, type PrescriptionCase } from '../cases.ts';
import { type Catalogues, loadCatalogues, searchCnmb } from '../catalogue.ts';

import { fieldF1, normal, prescriptionTask, routeOf } from './prescription.ts';

let catalogues: Catalogues;
let cases: PrescriptionCase[];
beforeAll(() => {
  catalogues = loadCatalogues();
  cases = loadInventedCases().prescription.cases;
});

const amoxicillin = () => cases.find((c) => c.id === 'receta-01')!;

describe('prescription task', () => {
  it('every invented receta names a CNMB medicine, presentation and route that exist', () => {
    for (const item of cases) {
      const medicine = catalogues.cnmb.find(
        (m) => m.code === item.expected.cnmbCode,
      );
      expect(medicine?.display, item.id).toBe(item.expected.substance);
      const presentation = medicine!.presentations.find(
        (p) =>
          p.form === item.expected.form &&
          p.concentration === item.expected.concentration,
      );
      expect(presentation, item.id).toBeDefined();
      expect(normal('route', routeOf(presentation!.route)), item.id).toBe(
        normal('route', item.expected.route),
      );
      // Arm D can reach it: the search finds the medicine in the dictation.
      expect(
        searchCnmb(item.dictation, catalogues.cnmb).map((m) => m.code),
        item.id,
      ).toContain(item.expected.cnmbCode);
    }
  });

  it('EV-6 compares fields without case, accents, spaces or the decimal comma', () => {
    expect(normal('concentration', '250 mg/5 mL')).toBe(
      normal('concentration', '250mg/5ml'),
    );
    expect(normal('concentration', '0,1 mg/dosis')).toBe('0.1mg/dosis');
    expect(normal('concentration', '100 mcg/dosis')).toBe('0.1mg/dosis');
    expect(normal('concentration', '400 mcg')).toBe(
      normal('concentration', '0,4 mg'),
    );
    expect(normal('dose', { amount: 2, unit: 'Tabletas' })).toBe('2 tableta');
    expect(normal('dose', { amount: 1, unit: 'inhalación' })).toBe(
      normal('dose', { amount: 1, unit: 'puff' }),
    );
    expect(normal('route', 'Tópica')).toBe('topica');
    expect(normal('substance', 'Losartán')).toBe(
      normal('substance', 'losartan'),
    );
  });

  it('EV-6 arm D builds the receta from the cuadro, and drops a code the cuadro does not have', async () => {
    const task = prescriptionTask(catalogues);
    const item = amoxicillin();
    const tablet =
      catalogues.cnmb
        .find((m) => m.code === 'J01CA04')!
        .presentations.findIndex((p) => p.form === 'TABLET') + 1;
    const schedule = {
      dose: { amount: 1, unit: 'tableta' },
      route: 'oral',
      everyHours: 8,
      days: 7,
    };

    const right = await task.evaluate(
      item,
      'D',
      { cnmbCode: 'J01CA04', presentation: tablet, ...schedule },
      null,
    );
    expect(right.scores).toMatchObject({
      substance: 1,
      form: 1,
      concentration: 1,
      dose: 1,
      route: 1,
      everyHours: 1,
      days: 1,
      all: 1,
      outsideCnmb: 0,
      empty: 0,
    });

    const invented = await task.evaluate(
      item,
      'D',
      { cnmbCode: 'ZZ99', presentation: 1, ...schedule },
      null,
    );
    expect(invented.shown).toMatchObject({ substance: null, cnmbCode: null });
    expect(invented.scores).toMatchObject({
      empty: 1,
      outsideCnmb: null,
      all: 0,
    });
  });

  it('EV-6 arm A shows what the model wrote, and a medicine outside the CNMB counts', async () => {
    const task = prescriptionTask(catalogues);
    const item = amoxicillin();
    const written = await task.evaluate(
      item,
      'A',
      {
        medicine: {
          substance: 'Amoxidal',
          form: 'TABLET',
          concentration: '500 mg',
          dose: { amount: 1, unit: 'tableta' },
          route: 'oral',
          everyHours: 8,
          days: null,
        },
      },
      null,
    );
    expect(written.scores).toMatchObject({
      substance: 0,
      concentration: 1,
      days: 0,
      all: 0,
      outsideCnmb: 1,
    });
  });

  it('EV-6 F1 per field: an empty field costs recall, a wrong one precision too', () => {
    const expected = amoxicillin().expected;
    const rows = [
      { expected, shown: { days: 7 } },
      { expected, shown: { days: null } },
      { expected, shown: { days: 5 } },
    ];
    const f1 = fieldF1(rows, 'days');
    expect(f1.predicted).toBe(2);
    expect(f1.expected).toBe(3);
    expect(f1.precision).toBeCloseTo(1 / 2, 10);
    expect(f1.recall).toBeCloseTo(1 / 3, 10);
    expect(f1.f1).toBeCloseTo(0.4, 10);
  });

  it('arm D lists the CNMB presentations in the prompt; A does not', () => {
    const task = prescriptionTask(catalogues);
    const a = task.request(amoxicillin(), 'A');
    const d = task.request(amoxicillin(), 'D');
    expect(a.prompt).not.toContain('CNMB');
    expect(d.prompt).toContain('- J01CA04 · Amoxicilina');
    expect(d.prompt).toMatch(
      /1\. Sólido oral · 500 mg · O - Oral \(forma: TABLET\)/,
    );
    expect([a.promptVersion, d.promptVersion]).toEqual([
      'receta-a-v1',
      'receta-d-v1',
    ]);
  });
});
