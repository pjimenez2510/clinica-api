import { describe, expect, it } from 'vitest';

import { AssistantNotConfiguredError } from '../domain/assistant.errors';

import type { PseudonymizedText } from './llm-client.port';
import {
  MissingPseudonymizer,
  type Pseudonymized,
  type Pseudonymizer,
  restorePlaceholders,
} from './pseudonymizer.port';

describe('Pseudonymizer port', () => {
  it('AS-025 hands the cleared text as PseudonymizedText, and a plain string is not one', () => {
    const answer: Pseudonymized = {
      cleared: 'Paciente [PERSONA_1] con odinofagia' as PseudonymizedText,
      replacements: [],
      dateShiftDays: 0,
    };
    const prompt: PseudonymizedText = answer.cleared;
    // @ts-expect-error AS-025: the raw note cannot stand for the cleared text.
    const raw: Pseudonymized['cleared'] = 'Paciente Ana Pérez';

    expect(prompt).toBe(answer.cleared);
    expect(raw).toBe('Paciente Ana Pérez');
  });

  it('AS-025 without a pseudonymizer every call fails with ASSISTANT_NOT_CONFIGURED', async () => {
    const missing: Pseudonymizer = new MissingPseudonymizer();

    await expect(
      missing.pseudonymize({ text: 'nota', subject: 'p-1' }),
    ).rejects.toBeInstanceOf(AssistantNotConfiguredError);
  });

  it('AS-025 restores the originals in what the model quoted, longest placeholder first', () => {
    const replacements = [
      { placeholder: '[PERSONA_1]', original: 'Ana', kind: 'name' },
      { placeholder: '[PERSONA_10]', original: 'Luis', kind: 'name' },
    ];

    expect(
      restorePlaceholders('[PERSONA_10] trae a [PERSONA_1]', replacements),
    ).toBe('Luis trae a Ana');
    // Control: text without placeholders comes back untouched.
    expect(restorePlaceholders('odinofagia', replacements)).toBe('odinofagia');
  });
});
