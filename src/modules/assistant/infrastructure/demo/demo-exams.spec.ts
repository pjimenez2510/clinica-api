import { describe, expect, it } from 'vitest';

import type { PseudonymizedText } from '../../application/llm-client.port';
import { instruction, withContext } from '../../application/llm-client.port';
import {
  catalogueContext,
  EXAMS_PURPOSE,
  examsAnswer,
} from '../../application/order-reading.prompts';
import { DemoLlmProvider } from './demo-llm.provider';

/** AS-029, AS-103. The exams of the demonstration script. Invented text. */
const CATALOGUE = [
  { serviceId: 's-1', code: 'IMG-ECO-ABDOMINAL', name: 'Ecografía abdominal', category: 'IMAGING' as const }, // prettier-ignore
  { serviceId: 's-2', code: 'IMG-RX-TORAX', name: 'Radiografía de tórax (PA y lateral)', category: 'IMAGING' as const }, // prettier-ignore
  { serviceId: 's-3', code: 'LAB-BH', name: 'Biometría hemática completa', category: 'LABORATORY' as const }, // prettier-ignore
  { serviceId: 's-4', code: 'LAB-GLUCOSA-AYUNAS', name: 'Glucosa en ayunas', category: 'LABORATORY' as const }, // prettier-ignore
];

describe('the demonstration script (AS-029)', () => {
  it('AS-103 asks for the exams the consultation says, quoting their sentence, with the numbers of the catalogue it was given', async () => {
    const provider = new DemoLlmProvider();
    const prompt = withContext(
      '<nota>\n## Plan\nSe solicita biometría hemática y radiografía de tórax. Perfil tiroideo en el control.\n</nota>' as PseudonymizedText, // prettier-ignore
      catalogueContext(CATALOGUE),
    );

    const answer = await provider.generate({
      tier: 'quality',
      purpose: EXAMS_PURPOSE,
      promptVersion: 'v1',
      system: instruction`demo`,
      prompt,
      answer: examsAnswer,
    });

    expect(answer.value.exams).toEqual([
      { requested: 'biometría hemática', quote: 'biometría hemática y radiografía de tórax', candidates: [3, 999] }, // prettier-ignore
      { requested: 'radiografía de tórax', quote: 'radiografía de tórax', candidates: [2] }, // prettier-ignore
      // Not in the catalogue: no number, the barrier shows only its sentence.
      { requested: 'perfil tiroideo', quote: 'Perfil tiroideo en el control', candidates: [] }, // prettier-ignore
    ]);
  });
});
