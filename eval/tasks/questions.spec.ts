import { describe, expect, it } from 'vitest';

import {
  QUESTIONS_INSTRUCTIONS,
  QUESTIONS_PURPOSE,
} from '../../src/modules/assistant/application/note-questions.prompts.ts';
import { loadInventedCases } from '../cases.ts';
import { loadCatalogues } from '../catalogue.ts';

import { questionsCases, questionsTask, referenceNote } from './questions.ts';

const [empty, written] = questionsCases(loadInventedCases().note.cases.slice(0, 1)); // prettier-ignore
const reviews: unknown[] = [];
const task = questionsTask(loadCatalogues(), { review: (entry) => reviews.push(entry) }); // prettier-ignore

describe('questions task (AS-126)', () => {
  it('AS-126 measures each case twice: with the note empty and with its reference note written', () => {
    expect([empty!.id, written!.id]).toEqual(['nota-01-vacia', 'nota-01-escrita']); // prettier-ignore
    expect(referenceNote(empty!)).toEqual({});
    expect(referenceNote(written!).motivoConsulta).toBe('Dolor de garganta.');
  });

  it('AS-126 asks with the product’s own request, the note as written after the conversation', () => {
    const request = task.request(written!, 'D');

    expect(request.purpose).toBe(QUESTIONS_PURPOSE);
    expect(request.system).toBe(QUESTIONS_INSTRUCTIONS);
    expect(request.prompt).toMatch(/^<conversacion>\n\[L1\] /);
    expect(request.prompt).toContain('- motivoConsulta · Motivo de consulta: Dolor de garganta.'); // prettier-ignore
    expect(task.request(empty!, 'D').prompt).toContain('<nota>\n(sin nada escrito)\n</nota>'); // prettier-ignore
    expect(task.latencyBudgetMs).toBe(5_000);
  });

  it('SC-093 counts what is shown and dropped, never a question without its line, and hands each one to the review with its line', async () => {
    const { shown, scores } = await task.evaluate(written!, 'D', {
      questions: [
        { text: '¿Desde cuándo?', source: 'L2', section: 'enfermedadActual' },
        { text: '¿Fuma?', source: 'L99', section: null },
      ],
    }, null); // prettier-ignore

    expect(scores).toEqual({ withoutLine: 0, shown: 1, dropped: 0.5 });
    expect(JSON.stringify(shown)).not.toMatch(/Desde cuándo|garganta/);
    expect(reviews.at(-1)).toMatchObject({
      caseId: 'nota-01-escrita',
      questions: [{ text: '¿Desde cuándo?', line: expect.stringMatching(/garganta/) }], // prettier-ignore
      dropped: 1,
    });
  });
});
