import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  instruction,
  type PseudonymizedText,
} from '../application/llm-client.port';

import { FakeLlmProvider } from './fake-llm.provider';

const answer = z.object({ summary: z.string() });

describe('FakeLlmProvider', () => {
  it('AS-002 answers with the model the tier names, not one the caller picks', async () => {
    const provider = new FakeLlmProvider([
      { kind: 'answer', text: '{"summary":"ok"}' },
    ]);

    const result = await provider.generate({
      tier: 'fast',
      purpose: 'test',
      promptVersion: 'v1',
      system: instruction`Resume`,
      prompt: 'Persona_1' as PseudonymizedText,
      answer,
    });

    expect(result.value).toEqual({ summary: 'ok' });
    expect(result.model).toBe(provider.modelFor('fast'));
    expect(provider.calls).toHaveLength(1);
  });
});
