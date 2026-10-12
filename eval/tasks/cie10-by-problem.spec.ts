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
  item('codiesp-S0001-1', ['N39.0'], 'codiesp'),
];
/** The corpus: N39.0 is coded in another article too, I10 only in S0001. */
const CORPUS = [
  { article: 'S0001', phrase: 'infección urinaria', code: 'n39.0' },
  { article: 'S0002', phrase: 'itu', code: 'n39.0' },
  { article: 'S0001', phrase: 'hta', code: 'i10' },
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
    expect(scores.invented).toBeCloseTo(1 / 3);
    // Control: without the barrier the invented code is shown as written.
    const raw = await task.evaluate(CASES[1]!, 'A', { codes: ['J02.7'] }, null);
    expect(raw.shown).toEqual(['J02.7']);
  });

  it("AS-027 AS-042 the baseline is the frequency of the corpus without the case's article, and does not apply to the invented set", async () => {
    const task = cie10ByProblemTask(catalogues, CASES);

    // The invented set has no history: its baseline does not apply.
    const b = await task.evaluate(CASES[1]!, 'D', { codes: [] }, null);
    expect(b.scores.baselineRecall5).toBeNull();
    expect(b.scores.gainOverBaseline).toBeNull();
    // CodiEsp's baseline is its whole corpus less the case's own article.
    const d = await task.evaluate(CASES[3]!, 'D', { codes: [] }, null);
    expect(d.scores.baselineRecall5).toBe(0);
    const withCorpus = cie10ByProblemTask(catalogues, CASES, CORPUS);
    const found = await withCorpus.evaluate(
      CASES[3]!,
      'D',
      { codes: [] },
      null,
    );
    // N39.0 is in S0002 as well: the clinic codes it, without this patient.
    expect(found.scores.baselineRecall5).toBe(1);
    const alone = cie10ByProblemTask(catalogues, CASES, CORPUS.filter((row) => row.article === 'S0001')); // prettier-ignore
    const none = await alone.evaluate(CASES[3]!, 'D', { codes: [] }, null);
    // Only its own article had it: leaving it out leaves nothing.
    expect(none.scores.baselineRecall5).toBe(0);
  });
});
