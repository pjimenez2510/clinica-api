import { beforeAll, describe, expect, it } from 'vitest';

import {
  type ExamNoteCase,
  loadExamCatalogue,
  loadInventedCases,
} from '../cases.ts';

import { ordersFromNoteTask, scoresOf } from './orders-from-note.ts';

let catalogue: ReturnType<typeof loadExamCatalogue>['exams'];
let cases: ExamNoteCase[];
beforeAll(() => {
  catalogue = loadExamCatalogue().exams;
  cases = loadInventedCases().examNote.cases;
});

const numberOf = (code: string) =>
  catalogue.findIndex((exam) => exam.code === code) + 1;

describe('examenes-nota task (AS-114)', () => {
  it('AS-114 at least forty invented notes, every exam expected is in the invented catalogue, and there are distractors', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const item of cases) {
      expect(item.origin).toBe('invented');
      for (const code of item.expected) {
        expect(numberOf(code), `${item.id} ${code}`).toBeGreaterThan(0);
      }
    }
    expect(cases.filter((item) => item.expected.length === 0).length).toBeGreaterThanOrEqual(3); // prettier-ignore
    expect(cases.filter((item) => item.conversation).length).toBeGreaterThanOrEqual(3); // prettier-ignore
  });

  it('AS-114 the exam asked for among the candidates counts, first or not; an invented number is never shown', async () => {
    const task = ordersFromNoteTask(catalogue);
    const item = cases.find((c) => c.id === 'examenes-nota-01')!;
    const answer = {
      exams: [
        { requested: 'bh', quote: 'biometría hemática', candidates: [numberOf('LAB-PCR'), numberOf('LAB-BH')] }, // prettier-ignore
        { requested: 'glucosa', quote: 'glucosa en ayunas', candidates: [numberOf('LAB-GLUCOSA-AYUNAS'), 999] }, // prettier-ignore
      ],
    };

    const result = await task.evaluate(item, 'D', answer, null);

    expect(result.shown).toEqual([['LAB-PCR', 'LAB-BH'], ['LAB-GLUCOSA-AYUNAS']]); // prettier-ignore
    expect(result.scores).toMatchObject({ recall: 1, first: 0.5, all: 1, extra: 0, outsideCatalogue: 0 }); // prettier-ignore
  });

  it('AS-103 AS-114 a result the patient brings is not a line; a line nobody asked for is «de más»; one with no candidate is not', async () => {
    const task = ordersFromNoteTask(catalogue);
    const item = cases.find((c) => c.id === 'examenes-nota-11')!; // «Trae biometría…» + EMO
    const answer = {
      exams: [
        { requested: 'bh', quote: 'biometría hemática de hace una semana', candidates: [numberOf('LAB-BH')] }, // prettier-ignore
        { requested: 'emo', quote: 'Se solicita EMO', candidates: [numberOf('LAB-EMO')] }, // prettier-ignore
      ],
    };

    const result = await task.evaluate(item, 'D', answer, null);
    expect(result.shown).toEqual([['LAB-EMO']]);
    expect(result.scores).toMatchObject({ recall: 1, extra: 0, all: 1 });

    expect(scoresOf(item, [['LAB-EMO'], ['LAB-BH']], new Set(['LAB-EMO', 'LAB-BH']))).toMatchObject({ extra: 1, all: 0 }); // prettier-ignore
    expect(scoresOf(item, [['LAB-EMO'], []], new Set(['LAB-EMO']))).toMatchObject({ extra: 0, all: 1 }); // prettier-ignore
  });

  it('AS-103 what was said aloud is read from the conversation, as the product reads the transcript', async () => {
    const task = ordersFromNoteTask(catalogue);
    const item = cases.find((c) => c.conversation && c.expected.includes('IMG-RX-TOBILLO'))!; // prettier-ignore
    const request = task.request(item, 'D');
    expect(request.prompt).toContain('<conversacion>');

    const result = await task.evaluate(item, 'D', { exams: [{ requested: 'rx', quote: 'sacar una radiografía del tobillo', candidates: [numberOf('IMG-RX-TOBILLO')] }] }, null); // prettier-ignore
    expect(result.scores).toMatchObject({ recall: 1 });
  });
});
