import { describe, expect, it } from 'vitest';

import { BLANK_CHARACTERS, isWritten } from './written-text';

/**
 * D-099 §5. The blank list must be EXACTLY what `trim` removes: the SQL side
 * is built from it, and the TypeScript side is `trim`.
 */
describe('written text', () => {
  it('EN-167 every listed blank is one `trim` removes', () => {
    for (const blank of BLANK_CHARACTERS) {
      expect(blank.trim()).toBe('');
    }
  });

  it('EN-167 no other character of the Basic Multilingual Plane is removed by `trim`', () => {
    const listed = new Set(BLANK_CHARACTERS);
    for (let point = 0; point <= 0xffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const char = String.fromCodePoint(point);
      if (!listed.has(char)) expect(char.trim()).toBe(char);
    }
  });

  it('EN-167 a note with only an Enter, a tab or a non-breaking space has nothing written', () => {
    expect(isWritten('\n')).toBe(false);
    expect(isWritten('\t  ')).toBe(false);
    expect(isWritten(' Cefalea ')).toBe(true);
  });
});
