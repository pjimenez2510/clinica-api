import { describe, expect, it } from 'vitest';

import type {
  LlmClient,
  PseudonymizedText,
} from '../../application/llm-client.port';
import { writeNoteDraft } from '../../application/note-writer';
import type { Pseudonymizer } from '../../application/pseudonymizer.port';
import { buildLexicon } from '../../domain/lexicon';

import { DemoLlmProvider } from './demo-llm.provider';

/** AS-099. The draft of the demonstration's script, through the product's writer. */
const lexicon = buildLexicon({ targets: ['Paracetamol'], protectedWords: [] });
const people = { subject: 'patient-1', names: [], staff: [] };
const identity: Pseudonymizer = {
  pseudonymize: (input) =>
    Promise.resolve({
      cleared: input.text as PseudonymizedText,
      replacements: [],
      dateShiftDays: 0,
    }),
};

describe('the demonstration draft (AS-099)', () => {
  it('AS-099 the demonstration provider drafts from its script, each phrase on its line, and one nobody said', async () => {
    const demo = new DemoLlmProvider();
    const llm: LlmClient = {
      async generate(request) {
        const answer = await demo.generate(request);
        return { value: answer.value, provider: 'fake', model: answer.model, requestId: 'r', runId: 'run-demo' }; // prettier-ignore
      },
    };
    const said = [
      { startMs: 0, endMs: 12_048, text: 'Buenos días, cuénteme qué le pasa. Desde hace tres días me duele la garganta y tengo fiebre.' }, // prettier-ignore
      { startMs: 12_049, endMs: 16_254, text: 'solo para acetamol de 500 miligramos cada 8 horas.' }, // prettier-ignore
      { startMs: 16_254, endMs: 24_018, text: 'Vamos a revisarle la garganta y tomarle la temperatura. Le indico control en 15 días.' }, // prettier-ignore
    ];
    const full = [
      { key: 'motivoConsulta', title: 'Motivo de consulta', help: '' },
      { key: 'enfermedadActual', title: 'Enfermedad o problema actual', help: '' }, // prettier-ignore
      { key: 'examenFisico', title: 'Examen físico regional', help: '' },
      { key: 'planTratamiento', title: 'Plan de tratamiento', help: '' },
    ];

    const { sections } = await writeNoteDraft(
      { pseudonymizer: identity, llm, lexicon },
      { ...people, lines: said, template: full },
    );

    expect(sections.map((section) => section.section)).toEqual([
      'motivoConsulta',
      'enfermedadActual',
      'examenFisico',
      'planTratamiento',
    ]);
    const phrases = sections.flatMap((section) => section.phrases);
    expect(phrases.filter((phrase) => phrase.unsaid)).toHaveLength(1);
    expect(phrases.some((phrase) => /paracetamol/i.test(phrase.text))).toBe(
      true,
    );
    expect(phrases.find((phrase) => /paracetamol/i.test(phrase.text))!.fromMs).toBe(12_049); // prettier-ignore
  });
});
