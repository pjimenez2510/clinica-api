import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  accessKeyCheckDigit,
  composeAccessKey,
  InvalidAccessKeyPartError,
  isValidAccessKey,
  numericCodeFrom,
} from './access-key';

/**
 * Keys printed in the SRI's Ficha Técnica v2.34 as examples. They are the
 * SRI's own test vectors, not anybody's real voucher.
 */
const FICHA_KEYS = [
  '0211202401050306179800120010020000000677300995216',
  '0403201301179226110400110015010000000081234567816',
  '0503201201176001321000110010030009900641234567814',
  '0601201601176001321000110011230000000081234567817',
  '0603201304176001321000110015010000000461234567817',
  '0603201306176001321000110015010000000081234567812',
  '1111202401099338176200110020010000003961234567815',
];

/**
 * The three keys of the Ficha that DO NOT check out (ADR-004): two SRI typos
 * and one extraction artefact. They stay here, failing, so nobody «fixes» the
 * algorithm to accept them.
 */
const FICHA_TYPOS = [
  '0403201301176815353000110015010000000081234567816',
  '2111202401176001321000110010010000011171234567810',
];

const PARTS = {
  issuedOn: parseClinicalDate('2026-09-30'),
  documentType: '01' as const,
  ruc: '1790001563001',
  environment: '1' as const,
  establishmentCode: '001',
  emissionPointCode: '001',
  sequential: '000000123',
  numericCode: '00456789',
};

describe('SRI-002 dígito verificador módulo 11', () => {
  it.each(FICHA_KEYS)(
    'SRI-002 la clave de la Ficha %s cuadra con el algoritmo',
    (key) => {
      expect(accessKeyCheckDigit(key.slice(0, 48))).toBe(Number(key[48]));
      expect(isValidAccessKey(key)).toBe(true);
    },
  );

  it.each(FICHA_TYPOS)(
    'SRI-002 la errata de la Ficha %s NO cuadra, y el algoritmo no se ajusta a ella',
    (key) => {
      expect(isValidAccessKey(key)).toBe(false);
    },
  );

  it('SRI-002 un residuo que da 11 se convierte en 0', () => {
    // 48 zeros: sum 0, 11 − 0 = 11 → 0.
    expect(accessKeyCheckDigit('0'.repeat(48))).toBe(0);
  });

  it('SRI-002 un residuo que da 10 se convierte en 1, a diferencia del RUC', () => {
    // Any 48 digits whose weighted sum is ≡ 1 (mod 11) give 11 − 1 = 10.
    const base = Array.from({ length: 100 }, (_, n) =>
      String(n).padStart(48, '0'),
    ).find((candidate) => {
      let sum = 0;
      for (let i = 0; i < 48; i += 1) {
        sum += Number(candidate[47 - i]) * (2 + (i % 6));
      }
      return sum % 11 === 1;
    });
    expect(base).toBeDefined();
    expect(accessKeyCheckDigit(base!)).toBe(1);
  });

  it('SRI-002 rechaza calcular sobre algo que no son 48 dígitos', () => {
    expect(() => accessKeyCheckDigit('123')).toThrow();
  });
});

describe('SRI-001 composición de la clave de acceso', () => {
  it('SRI-001 compone los 49 dígitos en el orden y con las longitudes de la Ficha', () => {
    const key = composeAccessKey(PARTS);

    expect(key).toHaveLength(49);
    expect(key.slice(0, 8)).toBe('30092026');
    expect(key.slice(8, 10)).toBe('01');
    expect(key.slice(10, 23)).toBe('1790001563001');
    expect(key.slice(23, 24)).toBe('1');
    expect(key.slice(24, 30)).toBe('001001');
    expect(key.slice(30, 39)).toBe('000000123');
    expect(key.slice(39, 47)).toBe('00456789');
    expect(key.slice(47, 48)).toBe('1');
    expect(isValidAccessKey(key)).toBe(true);
  });

  it('SRI-001 reproduce una clave de la Ficha a partir de sus partes', () => {
    // 05032012 · 01 · 1760013210001 · 1 · 001 003 · 000990064 · 12345678 · 1 · 4
    const key = composeAccessKey({
      issuedOn: parseClinicalDate('2012-03-05'),
      documentType: '01',
      ruc: '1760013210001',
      environment: '1',
      establishmentCode: '001',
      emissionPointCode: '003',
      sequential: '000990064',
      numericCode: '12345678',
    });
    expect(key).toBe('0503201201176001321000110010030009900641234567814');
  });

  it.each([
    ['ruc', { ruc: '179000156300' }],
    ['establishmentCode', { establishmentCode: '1' }],
    ['emissionPointCode', { emissionPointCode: '0001' }],
    ['sequential', { sequential: '123' }],
    ['numericCode', { numericCode: '1234567' }],
  ] as const)(
    'SRI-001 rechaza una parte sin la forma del SRI: %s',
    (part, override) => {
      expect(() => composeAccessKey({ ...PARTS, ...override })).toThrow(
        new InvalidAccessKeyPartError(part),
      );
    },
  );
});

describe('SRI-003 código numérico', () => {
  it('SRI-003 conserva los ceros a la izquierda', () => {
    expect(numericCodeFrom(() => 42)).toBe('00000042');
  });

  it('SRI-003 pide al generador todo el espacio de ocho dígitos', () => {
    let asked = 0;
    numericCodeFrom((max) => {
      asked = max;
      return 0;
    });
    expect(asked).toBe(100_000_000);
  });
});
