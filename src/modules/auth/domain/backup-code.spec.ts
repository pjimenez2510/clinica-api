import { describe, expect, it } from 'vitest';

import {
  BACKUP_CODE_ALPHABET,
  BACKUP_CODE_BITS,
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  formatBackupCode,
  generateBackupCodes,
  normalizeBackupCode,
} from './backup-code';

/**
 * AU-005 — what a backup code IS.
 *
 * The batch is handed over ONCE and then only its Argon2 hashes remain, so a
 * generator that quietly repeats itself or draws from a biased alphabet cannot
 * be noticed later by looking at the database. It has to be pinned here.
 */
describe('AU-005 códigos de respaldo del segundo factor', () => {
  it('AU-005 entrega un lote de códigos, todos distintos entre sí', () => {
    const batch = generateBackupCodes();

    expect(batch).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(batch.map((entry) => entry.canonical)).size).toBe(
      BACKUP_CODE_COUNT,
    );
  });

  it('AU-005 no repite un código entre lotes distintos', () => {
    // A generator seeded once, or one that derives the code from the user id,
    // passes the previous test and fails this one.
    const codes = Array.from({ length: 50 }, () => generateBackupCodes())
      .flat()
      .map((entry) => entry.canonical);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('AU-005 cada código lleva al menos 50 bits de entropía', () => {
    // The alphabet has to be a power of two: `byte % alphabet.length` is only
    // unbiased when it divides 256 exactly, and a biased draw silently removes
    // entropy from every code without changing how any of them look.
    expect(BACKUP_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(BACKUP_CODE_ALPHABET).size).toBe(32);
    expect(BACKUP_CODE_BITS).toBe(BACKUP_CODE_LENGTH * 5);
    expect(BACKUP_CODE_BITS).toBeGreaterThanOrEqual(50);

    for (const { canonical } of generateBackupCodes()) {
      expect(canonical).toHaveLength(BACKUP_CODE_LENGTH);
      for (const symbol of canonical) {
        expect(BACKUP_CODE_ALPHABET).toContain(symbol);
      }
    }
  });

  it('AU-005 se muestra en dos grupos y se guarda sin el separador', () => {
    // What the person copies off paper carries the hyphen; what is hashed does
    // not. Two representations of the same secret is exactly how a code that
    // was typed correctly ends up refused.
    for (const { display, canonical } of generateBackupCodes()) {
      expect(display).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      expect(normalizeBackupCode(display)).toBe(canonical);
      expect(formatBackupCode(canonical)).toBe(display);
    }
  });

  it('AU-005 acepta el código escrito a mano con minúsculas, espacios y letras confundibles', () => {
    // Read off paper and typed by somebody locked out of the clinic. The
    // alphabet is Crockford base32 precisely so O/0 and I/L/1 have a defined
    // reading instead of being a coin flip.
    const canonical = normalizeBackupCode('ABCDE-FGHJK');
    expect(canonical).toBe('ABCDEFGHJK');

    expect(normalizeBackupCode('abcde-fghjk')).toBe(canonical);
    expect(normalizeBackupCode('  ABCDE FGHJK ')).toBe(canonical);
    expect(normalizeBackupCode('ABCDEFGHJK')).toBe(canonical);
    // O reads as zero, I and L read as one — the Crockford mapping.
    expect(normalizeBackupCode('OIL23-45678')).toBe('0112345678');
  });

  it('AU-005 no confunde un código TOTP con uno de respaldo', () => {
    // The gate that decides whether a presented value is worth checking
    // against the stored hashes at all. A six-digit code must never reach it.
    expect(normalizeBackupCode('123456')).toBeNull();
    expect(normalizeBackupCode('')).toBeNull();
    expect(normalizeBackupCode('ABCDE-FGHJ')).toBeNull();
    expect(normalizeBackupCode('ABCDE-FGHJKL')).toBeNull();
    // `U` is not in the alphabet: Crockford leaves it out on purpose.
    expect(normalizeBackupCode('ABCDE-FGHJU')).toBeNull();
    expect(normalizeBackupCode('ABCDE-FGH!K')).toBeNull();
  });
});
