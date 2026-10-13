import { describe, expect, it } from 'vitest';

import { preparationAnswer } from '../../application/preparation-reading.prompts';
import { conversationOf } from '../../domain/note-draft';
import { readPreparationAnswer } from '../../domain/preparation-reading';

import { preparationOf } from './demo-preparation';

const LINES = [
  'Buenos días, ¿qué le trae por aquí?',
  'Me duele la espalda y el pecho desde ayer.',
  'Presión sistólica 120, presión diastólica 100.',
  'Talla 160, se lo midió de pie. Perímetro abdominal 65.',
  'Pesa ciento cincuenta libras. Hemoglobina 22.5.',
  'Frecuencia respiratoria noventa y dos y medio.',
  'Gracias, señorita.',
].map((text, at) => ({ startMs: at * 3_000, endMs: at * 3_000 + 2_500, text }));

describe('AS-254 the demonstration reads a preparation without a network', () => {
  it('AS-254 answers in the shape of a real reading, which the barrier then believes', () => {
    const { text, markers } = conversationOf(LINES);
    const answer = preparationAnswer.parse(preparationOf(text));

    const proposal = readPreparationAnswer({
      answer,
      lines: LINES,
      markers,
      restore: (phrase) => phrase,
    });

    expect(proposal.values).toMatchObject({
      systolicBp: { value: 120, startMs: 6_000 },
      diastolicBp: { value: 100 },
      heightCm: { value: 160 },
      abdominalCircumferenceCm: { value: 65 },
      weightKg: { value: 68 },
      hemoglobinGDl: { value: 22.5 },
    });
    expect(proposal.heightPosition).toMatchObject({ value: 'STANDING' });
    expect(proposal.complaint).toEqual({
      text: 'Me duele la espalda y el pecho desde ayer.',
      startMs: 3_000,
    });
    expect(proposal.speakers).toEqual(['nursing', 'patient', 'nursing', 'nursing', 'nursing', 'nursing', 'other']); // prettier-ignore
  });

  it('AS-254 names the respiratory rate no person can have, so the barrier is seen working', () => {
    const { text, markers } = conversationOf(LINES);
    const proposal = readPreparationAnswer({
      answer: preparationAnswer.parse(preparationOf(text)),
      lines: LINES,
      markers,
      restore: (phrase) => phrase,
    });
    expect(proposal.unclear).toEqual(['respiratoryRate']);
  });
});
