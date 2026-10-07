import { describe, expect, it } from 'vitest';

import {
  WallClockTime,
  atWallClock,
  clinicalDateOf,
} from '../domain/clinic-time';
import type { ClinicalDate } from '../domain/clinic-time';
import { ALLERGIES_NOT_RECORDED, allergyHistoryOf } from './allergy-history';

/**
 * PR-117, DOC-116 (D-157). The one sentence the receta says about allergies,
 * on the screen and on the paper.
 */

/** A day derived from the clock, never written by hand. */
function today(): ClinicalDate {
  return clinicalDateOf(new Date());
}

/** `YYYY-MM-DD` as the paper prints it. */
function printed(date: ClinicalDate): string {
  return date.split('-').reverse().join('/');
}

describe('allergyHistoryOf', () => {
  it('PR-117 DOC-116 con alergias las nombra, y la afirmación no cuenta', () => {
    const assertedAt = atWallClock(today(), WallClockTime.of(9, 0));
    expect(
      allergyHistoryOf(['Penicilina', 'Látex'], {
        assertedByName: 'Ana Pérez',
        assertedAt,
      }),
    ).toBe('Penicilina, Látex');
  });

  it('PR-117 DOC-116 sin alergias ni afirmación pide que se pregunte', () => {
    expect(allergyHistoryOf([], null)).toBe(
      'No registradas: pregunte al paciente',
    );
    expect(ALLERGIES_NOT_RECORDED).toBe('No registradas: pregunte al paciente');
  });

  it('PR-117 DOC-116 con la afirmación en pie dice quién y cuándo', () => {
    const day = today();
    const assertedAt = atWallClock(day, WallClockTime.of(9, 15));
    expect(
      allergyHistoryOf([], { assertedByName: 'Ana Pérez', assertedAt }),
    ).toBe(`Sin alergias conocidas (Ana Pérez, ${printed(day)})`);
  });

  it('PR-117 la fecha es la de Ecuador: a las 21:00 de Guayaquil sigue siendo ese día', () => {
    const day = today();
    const assertedAt = atWallClock(day, WallClockTime.of(21, 30));
    // In UTC that instant is already the next day: the positive control.
    expect(assertedAt.toISOString().slice(0, 10)).not.toBe(day);
    expect(
      allergyHistoryOf([], { assertedByName: 'Ana Pérez', assertedAt }),
    ).toBe(`Sin alergias conocidas (Ana Pérez, ${printed(day)})`);
  });

  it('PR-117 sin nombre de quien lo afirmó no dice «sin alergias»', () => {
    const assertedAt = atWallClock(today(), WallClockTime.of(9, 0));
    expect(allergyHistoryOf([], { assertedByName: '  ', assertedAt })).toBe(
      ALLERGIES_NOT_RECORDED,
    );
  });
});
