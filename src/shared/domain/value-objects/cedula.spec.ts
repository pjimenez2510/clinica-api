import { describe, expect, it } from 'vitest';

import { Cedula, InvalidCedulaError } from './cedula.vo';

describe('Cedula', () => {
  // Cedulas with a correct check digit, verified by hand against the modulo 10
  // algorithm. Test numbers, not real people.
  const VALID = [
    '1710034065', // Pichincha
    '1713175071', // Pichincha
    '0102030400', // Azuay
    '2400000010', // Santa Elena (last province)
    '3000000012', // foreigners
  ];

  describe('accepts valid cedulas', () => {
    it.each(VALID)('%s', (number) => {
      expect(Cedula.create(number).toString()).toBe(number);
    });
  });

  describe('rejects by format', () => {
    it.each([
      ['empty string', ''],
      ['too short', '171003406'],
      ['too long', '17100340651'],
      ['contains letters', '17100J4065'],
      ['contains dashes', '171-003-406'],
    ])('%s', (_case, input) => {
      expect(() => Cedula.create(input)).toThrow(InvalidCedulaError);
    });

    it('tolerates surrounding whitespace', () => {
      expect(Cedula.create('  1710034065  ').toString()).toBe('1710034065');
    });
  });

  describe('rejects by province', () => {
    it.each([
      ['province 00', '0010034065'],
      ['province 25 (does not exist)', '2510034062'],
      ['province 29 (does not exist)', '2910034069'],
      ['province 31 (does not exist)', '3110034060'],
    ])('%s', (_case, input) => {
      expect(() => Cedula.create(input)).toThrow(InvalidCedulaError);
    });
  });

  it('rejects a third digit >= 6, which belongs to RUC and not to a cedula', () => {
    // 6 = public sector, 9 = private company. Neither exists as a cedula.
    expect(() => Cedula.create('1760034060')).toThrow(InvalidCedulaError);
    expect(() => Cedula.create('1790034068')).toThrow(InvalidCedulaError);
  });

  it('rejects when the check digit does not match', () => {
    // Same valid number with the last digit altered: all must fail.
    const base = '171003406';
    const correctCheckDigit = 5;

    for (let d = 0; d <= 9; d++) {
      if (d === correctCheckDigit) continue;
      expect(() => Cedula.create(`${base}${d}`)).toThrow(InvalidCedulaError);
    }
  });

  it('does not leak the rejected number in the error', () => {
    // The message ends up in logs and support tickets: it cannot carry the
    // personal data that was rejected.
    try {
      Cedula.create('1710034060');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('1710034060');
      expect((e as InvalidCedulaError).code).toBe('INVALID_CEDULA');
    }
  });

  describe('behaviour', () => {
    it('exposes the province', () => {
      expect(Cedula.create('1710034065').province).toBe(17);
      expect(Cedula.create('0102030400').province).toBe(1);
    });

    it('masks for display', () => {
      expect(Cedula.create('1710034065').masked()).toBe('171****065');
    });

    it('compares by value, not by reference', () => {
      expect(
        Cedula.create('1710034065').equals(Cedula.create('1710034065')),
      ).toBe(true);
      expect(
        Cedula.create('1710034065').equals(Cedula.create('1713175071')),
      ).toBe(false);
    });

    it('isValid does not throw', () => {
      expect(Cedula.isValid('1710034065')).toBe(true);
      expect(Cedula.isValid('garbage')).toBe(false);
    });
  });
});
