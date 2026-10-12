import { describe, expect, it, vi } from 'vitest';

import { loadInventedCases } from '../cases.ts';
import type { Ask } from '../task.ts';

import { judgeRequest, noteTask, readVerdicts } from './note.ts';

const item = loadInventedCases().note.cases[0]!;

const note = {
  sections: [
    {
      section: 'motivo',
      segments: [{ text: 'Odinofagia', source: 2 }],
    },
    {
      section: 'plan',
      segments: [
        { text: 'Amoxicilina 500 mg c/8 h por 10 días', source: 8 },
        { text: 'Reposo absoluto', source: null },
      ],
    },
    { section: 'impresion', segments: [{ text: 'Viral', source: 99 }] },
  ],
};

const verdicts = (present: boolean[], supported: boolean[]) => ({
  facts: present.map((p, i) => ({ n: i + 1, present: p })),
  segments: supported.map((s, i) => ({ n: i + 1, supported: s })),
});

describe('note task', () => {
  it('counts sections outside the template and phrases without a line, with no model', async () => {
    const { scores } = await noteTask().evaluate(item, 'D', note, null);

    expect(scores.inventedSections).toBeCloseTo(1 / 3, 10);
    // `Reposo absoluto` has no line; `Viral` cites a line the case does not have.
    expect(scores.unbacked).toBeCloseTo(2 / 4, 10);
    expect(scores).toMatchObject({
      omission: null,
      invention: null,
      judged: 0,
    });
  });

  it('reads the judge per fact and per phrase, and keeps it apart', async () => {
    const facts = item.facts.length;
    const judge = vi.fn(() =>
      Promise.resolve(
        verdicts(
          Array.from({ length: facts }, (_, i) => i < 3),
          [true, true, false, false],
        ),
      ),
    ) as unknown as Ask;

    const { scores } = await noteTask().evaluate(item, 'D', note, judge);

    expect(scores.omission).toBeCloseTo((facts - 3) / facts, 10);
    expect(scores.invention).toBeCloseTo(2 / 4, 10);
    expect(scores.judged).toBe(1);
  });

  it('leaves the note unjudged when the judge does not answer or skips a verdict', async () => {
    const failing = (() => Promise.resolve(null)) as unknown as Ask;
    expect(
      (await noteTask().evaluate(item, 'D', note, failing)).scores,
    ).toMatchObject({
      omission: null,
      judged: 0,
    });

    expect(readVerdicts(verdicts([true], [true]), 2, 1)).toBeNull();
    expect(readVerdicts(verdicts([true, true], [true, true]), 2, 1)).toBeNull();
    expect(readVerdicts(verdicts([true, false], [false]), 2, 1)).toEqual({
      omitted: 1,
      unsupported: 1,
    });
  });

  it('the judge reads the conversation, the facts and the note, numbered', () => {
    const request = judgeRequest(item, note);
    expect(request.prompt).toContain('1. Médico: Buenos días');
    expect(request.prompt).toContain('Hechos:\n1. [motivo] dolor de garganta');
    expect(request.prompt).toContain(
      'Nota:\n1. [motivo] Odinofagia\n2. [plan] Amoxicilina',
    );
    expect(request.promptVersion).toBe('juez-nota-v1');
  });
});
