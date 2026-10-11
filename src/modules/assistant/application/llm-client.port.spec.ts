import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type LlmClient,
  type LlmRequest,
  type PseudonymizedText,
  withContext,
} from './llm-client.port';

const SOURCE_ROOT = join(process.cwd(), 'src');
const PORT_FILE = 'src/modules/assistant/application/llm-client.port.ts';

/** Every production `.ts` file under `src/`: specs mint test values freely. */
function productionSources(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

const answer = z.object({ summary: z.string() });

describe('LlmClient port', () => {
  it('AS-001 does not compile a call whose prompt is a plain string', () => {
    const client: Pick<LlmClient, 'generate'> = {
      generate: () => Promise.reject(new Error('not called')),
    };
    const raw = 'Paciente de 54 años con dolor torácico';
    const request = (prompt: string) =>
      ({
        tier: 'quality',
        purpose: 'test',
        promptVersion: 'v1',
        system: 'Resume',
        // @ts-expect-error AS-001: a string is not PseudonymizedText.
        prompt,
        answer,
      }) satisfies LlmRequest<typeof answer>;

    // The line above is the assertion: `tsc` fails if it ever compiles.
    expect(typeof client.generate).toBe('function');
    expect(request(raw).prompt).toBe(raw);
  });

  it('AS-001 lets no production file mint PseudonymizedText by a cast, except withContext', () => {
    const offenders = productionSources()
      .map((path) => relative(process.cwd(), path))
      .filter((path) => path !== PORT_FILE)
      .filter((path) =>
        /(as\s+PseudonymizedText\b|<PseudonymizedText>)/.test(
          readFileSync(join(process.cwd(), path), 'utf8'),
        ),
      );

    expect(offenders).toEqual([]);
    // Positive control: the scan does see the one sanctioned cast.
    expect(readFileSync(join(process.cwd(), PORT_FILE), 'utf8')).toMatch(
      /as PseudonymizedText/,
    );
  });

  it('AS-001 withContext appends system-composed text to cleared text and keeps the brand', () => {
    const cleared = 'Persona_1 refiere cefalea' as PseudonymizedText;

    const widened: PseudonymizedText = withContext(cleared, 'Catálogo: R51');

    expect(widened).toBe('Persona_1 refiere cefalea\n\nCatálogo: R51');
  });
});
