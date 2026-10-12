import { describe, expect, it } from 'vitest';

import type { PseudonymizedText } from '../../application/llm-client.port';
import { instruction } from '../../application/llm-client.port';
import {
  CODES_PURPOSE,
  codesAnswer,
  PROBLEMS_PURPOSE,
  problemsAnswer,
} from '../../application/problem-coding.prompts';
import {
  candidatesContext,
  LINES_PURPOSE,
  linesAnswer,
  MAPPING_PURPOSE,
  mappingAnswer,
  vocabularyContext,
  writtenLines,
} from '../../application/prescription-reading.prompts';
import { DemoLlmProvider } from './demo-llm.provider';
import { DemoPseudonymizer } from './demo.pseudonymizer';

const ask = <
  S extends
    | typeof problemsAnswer
    | typeof codesAnswer
    | typeof linesAnswer
    | typeof mappingAnswer,
>(
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

  it('AS-029 AS-063 reads the receta of the note from its own sentences, and a line the cuadro will not have', async () => {
    const provider = new DemoLlmProvider();
    const note = '<nota>\n## Plan\nAmoxicilina 500 mg, una tableta cada 8 horas por 7 días. Jarabe de miel con limón cada noche.\n</nota>'; // prettier-ignore

    const { value } = await provider.generate(ask(LINES_PURPOSE, `${note}\n\n${vocabularyContext()}`, linesAnswer)); // prettier-ignore

    expect(value.lines).toEqual([
      expect.objectContaining({
        drug: 'amoxicilina',
        strength: '500 mg',
        form: 'TABLET',
        doseAmount: 1,
        doseUnit: 'TABLET',
        frequency: 'EVERY_8_HOURS',
        durationDays: 7,
        quote: 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días',
      }),
      expect.objectContaining({ drug: 'jarabe de miel con limón', strength: null }), // prettier-ignore
    ]);
  });

  it('AS-029 AS-064 chooses the first candidate in the written strength, and none without candidates', async () => {
    const provider = new DemoLlmProvider();
    const prompt = `${writtenLines([
      { drug: 'amoxicilina', strength: '500 mg', form: 'TABLET' },
      { drug: 'jarabe de miel', strength: null, form: null },
    ])}\n\n${candidatesContext([
      [
        {
          conceptId: 'c-1',
          code: 'J01CA04',
          display: 'Amoxicilina',
          controlled: false,
          presentations: [
            {
              form: 'POWDER_FOR_ORAL_SUSPENSION',
              concentration: '250 mg/5 mL',
            },
            { form: 'TABLET', concentration: '500 mg', label: 'Sólido oral' },
          ],
        },
      ],
      [],
    ])}`;

    const { value } = await provider.generate(ask(MAPPING_PURPOSE, prompt, mappingAnswer)); // prettier-ignore

    expect(value.choices).toEqual([
      { line: 1, medicine: 1, presentation: 2 },
      { line: 2, medicine: null, presentation: null },
    ]);
  });
});
