import { describe, expect, it } from 'vitest';

import type { PseudonymizedText } from '../../application/llm-client.port';
import { instruction } from '../../application/llm-client.port';
import {
  CODES_PURPOSE,
  codesAnswer,
  PROBLEMS_PURPOSE,
  problemsAnswer,
} from '../../application/problem-coding.prompts';
import { DemoLlmProvider } from './demo-llm.provider';
import { DemoPseudonymizer } from './demo.pseudonymizer';

const ask = <S extends typeof problemsAnswer | typeof codesAnswer>(
  purpose: string,
  prompt: string,
  answer: S,
) => ({
  tier: 'quality' as const,
  purpose,
  promptVersion: 'v1',
  system: instruction`demo`,
  prompt: prompt as PseudonymizedText,
  answer,
});

describe('the demonstration script (AS-029)', () => {
  it('AS-029 names the problems the note contains, quoting it as written, and nothing else', async () => {
    const provider = new DemoLlmProvider();

    const answer = await provider.generate(
      ask(
        PROBLEMS_PURPOSE,
        '## Enfermedad actual\nRefiere Odinofagia de tres días. Tensión 150/95 en dos tomas.',
        problemsAnswer,
      ),
    );

    expect(answer.value.problems).toEqual([
      { problem: 'FARINGITIS AGUDA', quote: 'Odinofagia de tres días' },
      {
        problem: 'HIPERTENSIÓN ARTERIAL SIN DIAGNÓSTICO PREVIO',
        quote: '150/95 en dos tomas',
      },
    ]);
    expect(provider.name).toBe('fake');
    expect(answer.model).toBe('guion-de-demostracion');
  });

  it('AS-029 AS-035 writes a code that does not exist, so the barrier is seen working', async () => {
    const answer = await new DemoLlmProvider().generate(
      ask(CODES_PURPOSE, 'Problema: «FARINGITIS AGUDA»', codesAnswer),
    );

    expect(answer.value.codes).toContain('J02.7');
    expect(answer.value.codes[0]).toBe('J02.9');
  });

  it('AS-029 a problem the script does not know gets no codes', async () => {
    const answer = await new DemoLlmProvider().generate(
      ask(CODES_PURPOSE, 'Problema: «OTRA COSA»', codesAnswer),
    );

    expect(answer.value.codes).toEqual([]);
  });

  it('AS-029 the fake pseudonymizer replaces the names it is given and says how to put them back', async () => {
    const cleared = await new DemoPseudonymizer().pseudonymize({
      text: 'Ana Pérez trae a su hija Ana',
      subject: 'p-1',
      names: ['Ana', 'Pérez'],
    });

    expect(cleared.cleared).toBe(
      '[PERSONA_2] [PERSONA_1] trae a su hija [PERSONA_2]',
    );
    expect(cleared.replacements.map((each) => each.original)).toEqual([
      'Pérez',
      'Ana',
    ]);
  });
});
