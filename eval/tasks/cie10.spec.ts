import { beforeAll, describe, expect, it } from 'vitest';

import { loadInventedCases } from '../cases.ts';
import {
  type Catalogues,
  formatCode,
  loadCatalogues,
  searchCie10,
  toWhoCode,
} from '../catalogue.ts';

import { cie10Task, codiEspCases } from './cie10.ts';

let catalogues: Catalogues;
beforeAll(() => {
  catalogues = loadCatalogues();
});

const item = {
  id: 'x',
  origin: 'invented' as const,
  phrase: 'IVU baja',
  codes: ['N39.0'],
};

describe('CIE-10 task', () => {
  it('EV-5 reads the WHO list of the repository, with its version', () => {
    expect(catalogues.cie10.size).toBe(12_548);
    expect(catalogues.cie10.get('I10.X')).toBe(
      'Hipertensión esencial (primaria)',
    );
    expect(catalogues.versions.map((v) => v.file)).toEqual([
      'cie10-oms-deis-2026-08.xlsx',
      'cnmb-2026.xlsx',
    ]);
    expect(catalogues.versions[0]!.sha256).toBe(
      '0d5e19d5d68856aee9379cc91ec16ac931cbfb60dcd06575dec5089cc0a5a75a',
    );
  });

  it('EV-5 resolves CodiEsp and WHO codes to 4 characters, and nothing else', () => {
    const { cie10 } = catalogues;
    expect(toWhoCode('n39.0', cie10)).toBe('N39.0');
    expect(toWhoCode('i10', cie10)).toBe('I10.X');
    expect(toWhoCode('n28.89', cie10)).toBe('N28.8');
    expect(toWhoCode('q62.11', cie10)).toBe('Q62.1');
    expect(toWhoCode('J02.9', cie10)).toBe('J02.9');
    expect(toWhoCode('I10.X', cie10)).toBe('I10.X');
    // No equivalent: ICD-10-CM codes the WHO does not have, and garbage.
    expect(toWhoCode('u07.1', cie10)).toBe('U07.1');
    expect(toWhoCode('z79.899', cie10)).toBeNull();
    expect(toWhoCode('X', cie10)).toBeNull();
    expect(formatCode('j029')).toBe('J02.9');
    expect(formatCode('i10')).toBe('I10');
  });

  it('EV-5 takes CodiEsp into the WHO list, counting what has no equivalent, the same sample twice', () => {
    const rows = [
      { article: 'a', phrase: 'infección urinaria', code: 'n39.0' },
      { article: 'a', phrase: 'infección urinaria', code: 'n39.0' },
      { article: 'b', phrase: 'hipertensión', code: 'i10' },
      { article: 'c', phrase: 'uso de fármacos', code: 'z79.899' },
      // One phrase, two codes from the expert: one case that accepts both.
      { article: 'd', phrase: 'cefalea y fiebre', code: 'r51' },
      { article: 'd', phrase: 'cefalea y fiebre', code: 'r50.9' },
    ];
    const once = codiEspCases(rows, catalogues.cie10, { sample: 10, seed: 3 });
    const twice = codiEspCases(rows, catalogues.cie10, { sample: 10, seed: 3 });

    expect(once.total).toBe(6);
    expect(once.withoutEquivalent).toBe(1);
    expect(once.cases.map((c) => c.codes.join('+')).sort()).toEqual([
      'I10.X',
      'N39.0',
      'R51.X+R50.9',
    ]);
    expect(once.cases.every((c) => c.origin === 'codiesp')).toBe(true);
    expect(twice).toEqual(once);
  });

  it('arm D finds the expected code among its candidates for the invented set', () => {
    const { cie10: set } = loadInventedCases();
    const found = set.cases.filter((c) =>
      searchCie10(c.phrase, catalogues.cie10).some((r) => r.code === c.code),
    );
    // Not a quality bar: the lexical search must put the answer within reach
    // for most invented problems, or D measures the search and not the model.
    expect(found.length / set.cases.length).toBeGreaterThanOrEqual(0.8);
    expect(
      searchCie10('HTA esencial', catalogues.cie10).map((r) => r.code),
    ).toContain('I10.X');
  });

  it('EV-5 arm D hides a code that does not exist; arm A shows it and counts it as invented', async () => {
    const task = cie10Task(catalogues);
    // A00 (cólera) has .0, .1 and .9 only.
    const value = { codes: ['A00.5', 'n39.0', 'N30.0'] };

    const d = await task.evaluate(item, 'D', value, null);
    expect(d.shown).toEqual(['N39.0', 'N30.0']);
    expect(d.scores).toMatchObject({
      hit1: 1,
      recall5: 1,
      category1: 1,
      empty: 0,
    });
    // Invention is what the model wrote, in both arms: D hid it, it still wrote it.
    expect(d.scores.invented).toBeCloseTo(1 / 3, 10);

    const a = await task.evaluate(item, 'A', value, null);
    expect(a.shown).toEqual(['A00.5', 'N39.0', 'N30.0']);
    expect(a.scores).toMatchObject({ hit1: 0, recall5: 1, category1: 0 });
    expect(a.scores.invented).toBeCloseTo(1 / 3, 10);

    const none = await task.evaluate(item, 'D', { codes: ['A00.5'] }, null);
    expect(none.scores).toMatchObject({ hit1: 0, empty: 1, invented: 1 });
  });

  it('EV-5 the barrier removes and never repairs: a code written without its X fails in both arms', async () => {
    const task = cie10Task(catalogues);
    const hypertension = { ...item, phrase: 'HTA', codes: ['I10.X'] };
    for (const arm of ['A', 'D'] as const) {
      const { scores } = await task.evaluate(
        hypertension,
        arm,
        { codes: ['I10'] },
        null,
      );
      expect(scores, arm).toMatchObject({ hit1: 0, recall5: 0, invented: 1 });
    }
  });

  it('a phrase with several right codes is right with any of them first', async () => {
    const task = cie10Task(catalogues);
    const two = { ...item, codes: ['R51.X', 'R50.9'] };
    const { scores } = await task.evaluate(
      two,
      'D',
      { codes: ['R50.9'] },
      null,
    );
    expect(scores).toMatchObject({ hit1: 1, recall5: 1, category1: 1 });
  });

  it('arm D puts the catalogue in the prompt and A does not; both declare their prompt version', () => {
    const task = cie10Task(catalogues);
    const a = task.request(item, 'A');
    const d = task.request(item, 'D');

    expect(a.prompt).toBe('Problema: IVU baja');
    expect(d.prompt).toMatch(
      /^Problema: IVU baja\n\nCandidatos del catálogo CIE-10 OMS:\n- /,
    );
    expect(d.prompt).toContain('N39.0 · Infección de vías urinarias');
    expect([a.promptVersion, d.promptVersion]).toEqual([
      'cie10-a-v1',
      'cie10-d-v1',
    ]);
    expect(a.answer.safeParse({ codes: ['J02.9'] }).success).toBe(true);
  });
});
