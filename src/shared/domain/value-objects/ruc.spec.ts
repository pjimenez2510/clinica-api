import { describe, expect, it } from 'vitest';

import { InvalidRucError, Ruc } from './ruc.vo';

/**
 * OR-008, OR-009. The three RUC layouts. Only the natural person's carries a
 * check digit anybody can compute (its cedula, modulo 10); the SRI dropped
 * modulo 11 for companies in October 2021 (D-057).
 *
 * The synthetic numbers are computed by hand, never copied from a real
 * taxpayer. The exception is `SRI_ISSUED_WITHOUT_MODULUS_11`: two company RUCs
 * the Mintel published as test data when it reported the change, which is
 * exactly the evidence a synthetic number cannot give.
 *
 * The natural-person numbers are built on the same synthetic cedulas the
 * `Cedula` suite uses, so a change to the modulo-10 algorithm breaks both and
 * not just one.
 */
describe('Ruc', () => {
  const NATURAL = [
    '1710034065001', // Pichincha, establishment 001
    '1713175071002', // Pichincha, second establishment
    '0102030400001', // Azuay
    '2400000010001', // Santa Elena (last province)
    '3000000012001', // cedula registered abroad (30)
  ];

  /**
   * Real company RUCs issued with a sequential longer than six digits, which
   * spills into the old check digit position: neither passes modulo 11 (D-057,
   * minka.gob.ec/mintel/ge/rutr/gobec_forms/-/issues/32).
   */
  const SRI_ISSUED_WITHOUT_MODULUS_11 = ['1793189906001', '0993366721001'];

  /** Third digit 6: coefficients 3 2 7 6 5 4 3 2, check digit in position 9. */
  const PUBLIC_SECTOR = ['1760001550001', '0160012360001', '2460009990001'];

  /** Third digit 9: coefficients 4 3 2 7 6 5 4 3 2, check digit in position 10. */
  const PRIVATE_COMPANY = ['1790001563001', '0190012344001', '2490000189001'];

  describe('OR-008 accepts a natural person RUC, whose first ten digits are a cedula', () => {
    it.each(NATURAL)('%s', (number) => {
      const ruc = Ruc.create(number);
      expect(ruc.toString()).toBe(number);
      expect(ruc.kind).toBe('NATURAL_PERSON');
    });
  });

  describe('OR-008 accepts a public sector RUC', () => {
    it.each(PUBLIC_SECTOR)('%s', (number) => {
      const ruc = Ruc.create(number);
      expect(ruc.toString()).toBe(number);
      expect(ruc.kind).toBe('PUBLIC_SECTOR');
      // The public sector's establishment code is four digits, not three.
      expect(ruc.establishmentCode).toBe('0001');
    });
  });

  describe('OR-008 accepts a private company RUC', () => {
    it.each(PRIVATE_COMPANY)('%s', (number) => {
      const ruc = Ruc.create(number);
      expect(ruc.toString()).toBe(number);
      expect(ruc.kind).toBe('PRIVATE_COMPANY');
      expect(ruc.establishmentCode).toBe('001');
    });
  });

  describe('OR-009 accepts a company RUC that does not pass modulo 11', () => {
    it.each(SRI_ISSUED_WITHOUT_MODULUS_11)('%s', (number) => {
      const ruc = Ruc.create(number);
      expect(ruc.toString()).toBe(number);
      expect(ruc.kind).toBe('PRIVATE_COMPANY');
    });

    it('any digit in position 10 of a private company, and 9 of a public body', () => {
      for (let d = 0; d <= 9; d++) {
        expect(Ruc.isValid(`179000156${d}001`)).toBe(true);
        expect(Ruc.isValid(`17600015${d}0001`)).toBe(true);
      }
    });

    it('a company registered abroad (30), which the SRI numbers like a province', () => {
      expect(Ruc.create('3090000000001').kind).toBe('PRIVATE_COMPANY');
    });
  });

  describe('OR-008 rejects by format', () => {
    it.each([
      ['empty string', ''],
      ['a bare cedula, ten digits', '1710034065'],
      ['twelve digits', '171003406500'],
      ['fourteen digits', '17100340650011'],
      ['contains letters', '17100J4065001'],
      ['contains dashes', '1710034065-01'],
    ])('%s', (_case, input) => {
      expect(() => Ruc.create(input)).toThrow(InvalidRucError);
    });

    it('tolerates surrounding whitespace', () => {
      expect(Ruc.create('  1710034065001  ').toString()).toBe('1710034065001');
    });
  });

  describe('OR-008 rejects by province', () => {
    it.each([
      ['province 00', '0010034065001'],
      ['province 25 (does not exist)', '2510034062001'],
      ['province 29 (does not exist)', '2910034062001'],
      ['province 31 (does not exist)', '3110034060001'],
      // A company too: the province is checked before the kind.
      ['a company in province 25', '2590000000001'],
    ])('%s', (_case, input) => {
      expect(() => Ruc.create(input)).toThrow(InvalidRucError);
    });
  });

  it('OR-008 rejects a RUC that does not end in an establishment code', () => {
    // `000` is what a truncated or mistyped number looks like: a taxpayer
    // always has at least one establishment.
    expect(() => Ruc.create('1710034065000')).toThrow(InvalidRucError);
    expect(Ruc.create('1710034065001').establishmentCode).toBe('001');
  });

  it('OR-008 rejects a third digit of 7 or 8, which identifies no RUC kind', () => {
    expect(() => Ruc.create('1770034065001')).toThrow(InvalidRucError);
    expect(() => Ruc.create('1780034065001')).toThrow(InvalidRucError);
  });

  it('OR-009 rejects a natural person RUC whose cedula check digit is wrong', () => {
    const base = '171003406';
    const correctCheckDigit = 5;

    for (let d = 0; d <= 9; d++) {
      if (d === correctCheckDigit) continue;
      expect(() => Ruc.create(`${base}${d}001`)).toThrow(InvalidRucError);
    }
  });

  it('OR-008 does not leak the rejected number in the error', () => {
    // A natural person's RUC contains their cedula. This message reaches logs
    // and support screenshots.
    try {
      Ruc.create('1710034060001');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('1710034060001');
      expect((e as InvalidRucError).code).toBe('INVALID_RUC');
      // The form needs to know which box to highlight.
      expect((e as InvalidRucError).fieldErrors?.[0]?.field).toBe('ruc');
    }
  });

  describe('behaviour', () => {
    it('exposes the province of registration', () => {
      expect(Ruc.create('1710034065001').province).toBe(17);
      expect(Ruc.create('0102030400001').province).toBe(1);
    });

    it('compares by value, not by reference', () => {
      expect(
        Ruc.create('1710034065001').equals(Ruc.create('1710034065001')),
      ).toBe(true);
      expect(
        Ruc.create('1710034065001').equals(Ruc.create('1710034065002')),
      ).toBe(false);
    });

    it('isValid does not throw', () => {
      expect(Ruc.isValid('1790001563001')).toBe(true);
      expect(Ruc.isValid('garbage')).toBe(false);
    });
  });
});
