import { describe, expect, it } from 'vitest';

import { DurationNotSlotMultipleError } from './errors/slot-atom.errors';
import {
  assertDurationFitsSlotAtom,
  clinicSlotAtom,
  isSlotMultiple,
  slotMultipleMessage,
} from './slot-atom';

/**
 * D-021. The grid is one atom per site and every configurable duration is a
 * multiple of it. These are the two questions the rule reduces to: does this
 * duration tile that atom, and which atom does a clinic-wide duration owe
 * itself to when each site dices its day differently.
 */
describe('SP-021 a duration is a whole number of slots', () => {
  it('SP-021 accepts a duration that is an exact multiple of the atom', () => {
    expect(isSlotMultiple(30, 10)).toBe(true);
    expect(isSlotMultiple(10, 10)).toBe(true);
    expect(isSlotMultiple(45, 15)).toBe(true);
  });

  it('SP-021 rejects a duration that leaves a remainder on the grid', () => {
    // The case the database already held: a 20-minute type on a 30-minute
    // grid was configurable and impossible to book.
    expect(isSlotMultiple(20, 30)).toBe(false);
    expect(isSlotMultiple(25, 10)).toBe(false);
  });

  it('SP-021 rejects zero minutes, which divides every atom and is no appointment', () => {
    expect(isSlotMultiple(0, 10)).toBe(false);
  });

  it('SP-021 rejects a negative or fractional duration', () => {
    expect(isSlotMultiple(-10, 10)).toBe(false);
    expect(isSlotMultiple(10.5, 10)).toBe(false);
  });
});

describe('SP-021 the atom a clinic-wide duration answers to', () => {
  it('SP-021 is the atom itself when every site dices the day the same way', () => {
    expect(clinicSlotAtom([10, 10, 10])).toBe(10);
  });

  it('SP-021 is the lowest common multiple when sites disagree', () => {
    // A service type has no site, so it has to be bookable at both: only a
    // multiple of 30 divides evenly into a 10-minute and a 15-minute grid.
    expect(clinicSlotAtom([10, 15])).toBe(30);
    expect(clinicSlotAtom([10, 20])).toBe(20);
    expect(clinicSlotAtom([15, 20, 10])).toBe(60);
  });

  it('SP-021 is nothing at all when there is no site, because there is no grid', () => {
    expect(clinicSlotAtom([])).toBeNull();
  });

  it('SP-021 ignores an atom that is not a usable increment', () => {
    expect(clinicSlotAtom([0, -5, 10])).toBe(10);
  });
});

describe('SP-021 the refusal names the atom', () => {
  it('SP-021 refuses the duration per field and says which multiple to type', () => {
    let raised: unknown;
    try {
      assertDurationFitsSlotAtom('durationMinutes', 25, 10);
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(DurationNotSlotMultipleError);
    const error = raised as DurationNotSlotMultipleError;
    expect(error.code).toBe('DURATION_NOT_SLOT_MULTIPLE');
    expect(error.fieldErrors).toEqual([
      {
        field: 'durationMinutes',
        code: 'DURATION_NOT_SLOT_MULTIPLE',
        message: slotMultipleMessage(10),
      },
    ]);
    // The number is in the sentence: «fuera de rango» sends the administrator
    // to read the source, and the multiple is what tells them what to type.
    expect(error.fieldErrors?.[0]?.message).toContain('10 minutos');
  });

  it('SP-021 accepts a duration that fits, and says nothing', () => {
    expect(() =>
      assertDurationFitsSlotAtom('durationMinutes', 30, 10),
    ).not.toThrow();
  });

  it('SP-021 refuses nothing when no site declares a grid', () => {
    expect(() =>
      assertDurationFitsSlotAtom('durationMinutes', 7, null),
    ).not.toThrow();
  });
});
