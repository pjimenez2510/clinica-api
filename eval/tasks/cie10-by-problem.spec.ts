import { describe, expect, it } from 'vitest';

import type { Catalogues } from '../catalogue.ts';
import { CODES_PURPOSE } from '../../src/modules/assistant/application/problem-coding.prompts.ts';

import type { Cie10EvalCase } from './cie10.ts';
import { cie10ByProblemTask } from './cie10-by-problem.ts';

const catalogues = {
  cie10: new Map([
    ['J02.9', 'Faringitis aguda, no especificada'],
    ['J02.8', 'Faringitis aguda debida a otros microorganismos'],
    ['I10.X', 'Hipertensión esencial'],
    ['N39.0', 'Infección de vías urinarias'],
  ]),
  cnmb: [],
  versions: [],
} as unknown as Catalogues;

const item = (
  id: string,
  codes: string[],
  origin: Cie10EvalCase['origin'] = 'invented',
): Cie10EvalCase => ({
  // prettier-ignore
  id,
  origin,
  phrase: `problema ${id}`,
  codes,
});

const CASES = [
  item('a', ['J02.9']),
  item('b', ['I10.X']),
  item('c', ['I10.X']),
  item('d', ['N39.0'], 'codiesp'),
];

describe('cie10-problema (AS-042)', () => {
  it('AS-042 asks with the product prompt, not with a prompt of its own', () => {
    const task = cie10ByProblemTask(catalogues, CASES);

    const request = task.request(CASES[0]!, 'D');

    expect(request.prompt).toBe('Problema: «problema a»');
    expect(request.system).toMatch(/Da hasta cinco códigos/);
    expect(CODES_PURPOSE).toBe('cie10-codes');
  });

  it('AS-035 AS-042 the barrier shows only what resolves, so nothing invented is shown', async () => {
    const task = cie10ByProblemTask(catalogues, CASES);

    const { shown, scores } = await task.evaluate(
      CASES[1]!,
      'D',
      { codes: ['I10', 'J02.7', 'i10.x'] },
      null,
    );

    expect(shown).toEqual(['I10.X']);
    expect(scores.recall5).toBe(1);
    expect(scores.inventedShown).toBe(0);
    expect(scores.invented).toBeCloseTo(1 / 3);
    // Control: without the barrier the invented code is shown.
    const raw = await task.evaluate(CASES[1]!, 'A', { codes: ['J02.7'] }, null);
    expect(raw.scores.inventedShown).toBe(1);
  });

  it('AS-027 AS-042 the baseline is the frequency of its own source, without the case itself', async () => {
    const task = cie10ByProblemTask(catalogues, CASES);

    // b's own I10.X leaves one more I10.X (c): the baseline finds it.
    const b = await task.evaluate(CASES[1]!, 'D', { codes: [] }, null);
    expect(b.scores.baselineRecall5).toBe(1);
    expect(b.scores.gainOverBaseline).toBe(-1);
    // a is the only J02.9 of its source: the baseline cannot find it, the model can.
    const a = await task.evaluate(CASES[0]!, 'D', { codes: ['J02.9'] }, null);
    expect(a.scores.baselineRecall5).toBe(0);
    expect(a.scores.gainOverBaseline).toBe(1);
    // d's source is CodiEsp: the invented set's codes do not count for it.
    const d = await task.evaluate(CASES[3]!, 'D', { codes: [] }, null);
    expect(d.scores.baselineRecall5).toBe(0);
  });
});
