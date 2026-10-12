import { describe, expect, it, vi } from 'vitest';

import {
  DRAFT_INSTRUCTIONS,
  DRAFT_PURPOSE,
} from '../../src/modules/assistant/application/note-draft.prompts.ts';
import {
  buildLexicon,
  correctLine,
} from '../../src/modules/assistant/domain/lexicon.ts';
import { loadInventedCases } from '../cases.ts';
import { loadCatalogues } from '../catalogue.ts';
import type { Ask } from '../task.ts';

import { draftTask, heardCase } from './draft.ts';

const item = loadInventedCases().note.cases[0]!;
const task = draftTask(loadCatalogues());

const verdicts = (present: boolean[], phrases: number) => ({
  facts: present.map((p, i) => ({ n: i + 1, present: p })),
  segments: Array.from({ length: phrases }, (_, i) => ({ n: i + 1, supported: true })), // prettier-ignore
});

describe('draft task (AS-098)', () => {
  it('hands the case over as the listening would: no speaker, a clock per line', () => {
    const lines = heardCase(item);

    expect(lines[0]).toEqual({ startMs: 0, endMs: 5_000, text: item.lines[0]!.replace(/^Médico: /, '') }); // prettier-ignore
    expect(lines.every((line) => !/^(Médico|Paciente):/.test(line.text))).toBe(
      true,
    );
  });

  it('asks with the product’s own request: its purpose, its instructions, the template after the conversation', () => {
    const request = task.request(item, 'D');

    expect(request.purpose).toBe(DRAFT_PURPOSE);
    expect(request.system).toBe(DRAFT_INSTRUCTIONS);
    expect(request.prompt).toMatch(/^<conversacion>\n\[L1\] /);
    expect(request.prompt).toContain('- planTratamiento · Plan de tratamiento');
    expect(task.latencyBudgetMs).toBe(15_000);
  });

  it('SC-091 counts a case with a section nobody said, the unsaid phrases, and the facts the judge finds', async () => {
    const judge = vi.fn(() =>
      Promise.resolve(
        verdicts(
          item.facts.map((_, i) => i !== 0),
          3,
        ),
      ),
    ) as unknown as Ask;

    const { shown, scores } = await task.evaluate(
      item,
      'D',
      {
        sections: [
          { section: 'motivoConsulta', segments: [{ text: 'Dolor de garganta', source: 'L2' }] }, // prettier-ignore
          { section: 'enfermedadActual', segments: [{ text: 'Fiebre nocturna', source: 'L2' }] }, // prettier-ignore
          { section: 'revisionOrganosSistemas', segments: [{ text: 'Sin disnea', source: null }] }, // prettier-ignore
        ],
      },
      judge,
    );

    // nota-01: 11 facts, one of them a diagnosis the draft never writes (D-249 §2).
    expect(item.facts.filter((f) => f.section === 'diagnostico')).toHaveLength(
      1,
    );
    expect(scores).toEqual({
      invented: 1,
      facts: 9 / 10,
      factsWithDiagnosis: 10 / 11,
      unsaid: 1 / 3,
      judged: 1,
    });
    expect(shown).toEqual({
      sections: 3,
      invented: 1,
      phrases: 3,
      unsaid: 1,
      corrected: 0,
      facts: { present: 9, expected: 10 },
      diagnosis: { present: 1, expected: 1 },
    });
  });

  it('SC-091 hands each fact and phrase with its verdict to the manual review, and nothing to the result', async () => {
    const review = vi.fn();
    const reviewed = draftTask(loadCatalogues(), { review });
    const judge = vi.fn(() =>
      Promise.resolve(
        verdicts(
          item.facts.map((_, i) => i !== 0),
          1,
        ),
      ),
    ) as unknown as Ask;

    await reviewed.evaluate(
      item,
      'D',
      { sections: [{ section: 'motivoConsulta', segments: [{ text: 'Dolor de garganta', source: 'L2' }] }] }, // prettier-ignore
      judge,
    );

    expect(review).toHaveBeenCalledWith({
      caseId: item.id,
      phrases: [{ section: 'motivoConsulta', text: 'Dolor de garganta.', unsaid: false, supported: true }], // prettier-ignore
      facts: item.facts.map((fact, i) => ({ ...fact, present: i !== 0 })),
    });
  });

  it('SC-091 a draft every section of which somebody said has no invented one', async () => {
    const { scores } = await task.evaluate(
      item,
      'D',
      { sections: [{ section: 'motivoConsulta', segments: [{ text: 'Dolor de garganta', source: 'L2' }] }] }, // prettier-ignore
      null,
    );

    expect(scores).toMatchObject({
      invented: 0,
      unsaid: 0,
      facts: null,
      factsWithDiagnosis: null,
      judged: 0,
    });
  });
});

describe('the lexicon against the real CNMB (AS-092)', () => {
  const catalogues = loadCatalogues();
  const lexicon = buildLexicon({
    targets: catalogues.cnmb.map((medicine) => medicine.display),
    protectedWords: [...catalogues.cie10.values()],
  });

  it('joins what whisper split: «para acetamol» is paracetamol (positive control)', () => {
    expect(correctLine('solo para acetamol de 500 miligramos', lexicon).text).toBe('solo paracetamol de 500 miligramos'); // prettier-ignore
  });

  it.each([
    'Le doy metamizol cada 8 horas.',
    'Cefixima 400 mg al día.',
    'Valaciclovir por siete días.',
    'Tome un litro de agua al día.',
    'Lo tío dice que es socio de la comida ácida.',
    'Amoxicilna de quinientos.',
  ])('never turns a word said into a drug nobody said: «%s»', (line) => {
    expect(correctLine(line, lexicon)).toEqual({ text: line, changes: 0 });
  });
});
