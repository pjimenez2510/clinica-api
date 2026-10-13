import { describe, expect, it } from 'vitest';

import { readChart } from '../../application/chart-reader';
import type {
  LlmClient,
  PseudonymizedText,
} from '../../application/llm-client.port';
import type { Pseudonymizer } from '../../application/pseudonymizer.port';

import { DemoLlmProvider } from './demo-llm.provider';

/** AS-260, AS-278. The chart of the demonstration's script, through the product's reader. */
const identity: Pseudonymizer = {
  pseudonymize: (input) =>
    Promise.resolve({ cleared: input.text as PseudonymizedText, replacements: [], dateShiftDays: 0 }), // prettier-ignore
};
const demo = new DemoLlmProvider();
const llm: LlmClient = {
  async generate(request) {
    const answer = await demo.generate(request);
    return { value: answer.value, provider: 'fake', model: answer.model, requestId: 'r', runId: 'run-demo' }; // prettier-ignore
  },
};
const people = { subject: 'patient-1', names: [], staff: [] };

describe('the chart in the demonstration (AS-278)', () => {
  it('AS-278 the libreto: «sin alergias conocidas» and «Hipertensión arterial · Madre», each on its line', async () => {
    const lines = [
      { startMs: 0, endMs: 3_000, text: '¿Es alérgica a algún medicamento?' },
      { startMs: 3_500, endMs: 6_000, text: 'No, que yo sepa, a ninguno.' },
      { startMs: 6_500, endMs: 9_000, text: '¿Alguna enfermedad que tenga usted o su familia?' }, // prettier-ignore
      { startMs: 9_500, endMs: 12_000, text: 'Yo no. Mi mamá es hipertensa.' },
    ];

    const { kept, dropped } = await readChart({ pseudonymizer: identity, llm, lexicon: null }, { ...people, lines }); // prettier-ignore

    expect(dropped).toBe(0);
    expect(kept.map((each) => [each.text, each.fromMs])).toEqual([
      ['Sin alergias conocidas', 3_500],
      ['Hipertensión arterial · Madre', 9_500],
    ]);
  });

  it('AS-278 the variant with the allergy: the amoxicillin with its reaction, and no «sin alergias»', async () => {
    const lines = [
      { startMs: 0, endMs: 3_000, text: '¿Es alérgica a algún medicamento?' },
      { startMs: 3_500, endMs: 6_000, text: 'Sí, soy alérgica a la amoxicilina, me da ronchas.' }, // prettier-ignore
    ];

    const { kept } = await readChart({ pseudonymizer: identity, llm, lexicon: null }, { ...people, lines }); // prettier-ignore

    expect(kept.map((each) => each.text)).toEqual(['Amoxicilina · ronchas']);
  });
});
