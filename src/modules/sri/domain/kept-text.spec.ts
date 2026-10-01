import { describe, expect, it } from 'vitest';

import { capped, cutMark, summaryOf } from './kept-text';

/**
 * A «carácter» is a Unicode code point, as PostgreSQL's `char_length` and the
 * `electronic_voucher_attempt_response_is_capped` CHECK count them: the two
 * marks (SRI-059 when keeping, SRI-069 when summarising) say the same thing.
 */
describe('SRI-059 SRI-069 lo que se guarda y se resume del SRI dice cuánto se cortó', () => {
  it('SRI-059 un texto dentro del tope queda igual', () => {
    expect(capped('HTTP 500', 10)).toBe('HTTP 500');
  });

  it('SRI-059 un texto pasado del tope se corta y la marca cuenta lo que falta', () => {
    expect(capped('abcdefghij', 4)).toBe(`abcd${cutMark(6)}`);
    expect(cutMark(6)).toBe('… [cortado: 6 caracteres más]');
  });

  it('SRI-059 nunca parte un carácter en dos, y cuenta caracteres, no unidades UTF-16', () => {
    // «😀» is one character and two UTF-16 units; cutting at 2 would split it.
    expect(capped('a😀b', 2)).toBe(`a${cutMark(2)}`);
    expect(capped('ab😀😀', 2)).toBe(`ab${cutMark(2)}`);
  });

  it('SRI-069 el resumen lleva la marca solo si algo quedó fuera, contado como lo cuenta la base', () => {
    expect(summaryOf('javax…', 0)).toBe('javax…');
    expect(summaryOf('😀'.repeat(3), 1)).toBe(`${'😀'.repeat(3)}${cutMark(1)}`);
    expect(summaryOf(null, 0)).toBeNull();
  });
});
