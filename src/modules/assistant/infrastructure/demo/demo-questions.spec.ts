import { describe, expect, it } from 'vitest';

import type {
  LlmClient,
  PseudonymizedText,
} from '../../application/llm-client.port';
import { askNoteQuestions } from '../../application/note-questions';
import type { Pseudonymizer } from '../../application/pseudonymizer.port';

import { DemoLlmProvider } from './demo-llm.provider';

/** AS-127. The questions of the demonstration's script, through the product's function. */
const identity: Pseudonymizer = {
  pseudonymize: (input) =>
    Promise.resolve({
      cleared: input.text as PseudonymizedText,
      replacements: [],
      dateShiftDays: 0,
    }),
};
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
const template = [
  { key: 'motivoConsulta', title: 'Motivo de consulta', help: '', kind: 'TEXT' as const }, // prettier-ignore
  { key: 'enfermedadActual', title: 'Enfermedad o problema actual', help: '', kind: 'TEXT' as const }, // prettier-ignore
  { key: 'revisionOrganosSistemas', title: 'Revisión de órganos y sistemas', help: '', kind: 'TEXT' as const }, // prettier-ignore
];
const ask = (written: Record<string, string>) =>
  askNoteQuestions(
    { pseudonymizer: identity, llm, lexicon: null },
    { subject: 'p', names: [], staff: [], lines: said, template, written, discarded: [] }, // prettier-ignore
  );

describe('the demonstration questions (AS-127)', () => {
  it('AS-127 asks from its script, each question on its line, and the one with a marker it was not given is not shown', async () => {
    const { kept, dropped } = await ask({});

    expect(kept.map((each) => [each.text, each.fromMs])).toEqual([
      ['¿Hasta qué temperatura llegó la fiebre?', 0],
      ['¿Tiene tos o le cuesta tragar?', 0],
      ['¿Toma algún otro medicamento?', 12_049],
    ]);
    expect(dropped).toBe(1);
  });

  it('AS-123 AS-127 a question whose answer the note already writes is not asked again', async () => {
    const { kept } = await ask({ enfermedadActual: 'Fiebre de hasta 38,5 °C.' });

    expect(kept.map((each) => each.text)).not.toContain('¿Hasta qué temperatura llegó la fiebre?'); // prettier-ignore
    expect(kept).toHaveLength(2);
  });
});
