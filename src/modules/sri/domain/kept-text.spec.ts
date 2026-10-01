import { describe, expect, it } from 'vitest';

import { capped, cutMark } from './kept-text';

describe('SRI-059 lo que se guarda del SRI dice cuánto se cortó', () => {
  it('SRI-059 un texto dentro del tope queda igual', () => {
    expect(capped('HTTP 500', 10)).toBe('HTTP 500');
  });

  it('SRI-059 un texto pasado del tope se corta y la marca cuenta lo que falta', () => {
    expect(capped('abcdefghij', 4)).toBe(`abcd${cutMark(6)}`);
    expect(cutMark(6)).toBe('… [cortado: 6 caracteres más]');
  });

  it('SRI-059 nunca parte un carácter en dos', () => {
    // «😀» is two UTF-16 units; cutting at 2 would split it.
    expect(capped('a😀b', 2)).toBe(`a${cutMark(3)}`);
  });
});
