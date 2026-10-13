import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readDictatedVitals } from '../../src/modules/assistant/domain/dictated-vitals.ts';

import { DICTATION_CASES, loadDictationCases } from './cases.ts';

function folderWith(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictado-'));
  writeFileSync(join(dir, DICTATION_CASES), JSON.stringify(content));
  return dir;
}

describe('AS-188 the dictated phrases', () => {
  it('AS-188 stops the run before measuring a file that is not invented', () => {
    const dir = folderWith({ origin: 'clinic', description: '', cases: [{ id: 'a', category: 'c', text: 't', expected: {} }] }); // prettier-ignore

    expect(() => loadDictationCases(dir)).toThrow(/EV-1/);
  });

  it('AS-188 refuses a file that repeats an id', () => {
    const item = { id: 'a', category: 'c', text: 't', expected: {} };
    const dir = folderWith({ origin: 'invented', description: '', cases: [item, item] }); // prettier-ignore

    expect(() => loadDictationCases(dir)).toThrow(/repite/);
  });

  it('AS-188 SC-096 the product reads every written phrase of the set without a serious value', () => {
    for (const item of loadDictationCases()) {
      const { signs } = readDictatedVitals(item.text);
      for (const [field, value] of Object.entries(signs)) {
        expect(item.expected, `${item.id} ${field}`).toHaveProperty(
          field,
          value,
        );
      }
    }
  });
});
