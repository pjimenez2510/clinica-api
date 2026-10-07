import { describe, expect, it } from 'vitest';

import { cutoverOf, nextClinicDay } from './cutover';

/**
 * EN-233, PR-116, ORD-133. A new edition rules from the day AFTER its import,
 * in Ecuador: an attention opened this morning keeps the concepts of its day.
 */
describe('nextClinicDay (EN-233, PR-116, ORD-133)', () => {
  /** An instant built from a clinic-day and an hour, never a written date. */
  const at = (base: Date, hoursUtc: number) =>
    new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hoursUtc)); // prettier-ignore

  it('EN-233: the next day in Guayaquil, as a date at UTC midnight', () => {
    const today = new Date();
    const noonInEcuador = at(today, 17);
    const next = nextClinicDay(noonInEcuador);

    expect(next.getTime() - at(today, 0).getTime()).toBe(86_400_000);
  });

  it('EN-233: at 21:00 in Ecuador it is still the same clinic day, though UTC moved on', () => {
    const today = new Date();
    // 21:00 in Guayaquil is 02:00 UTC of the following day.
    const lateEvening = new Date(at(today, 0).getTime() + 26 * 3_600_000);

    expect(nextClinicDay(lateEvening).getTime()).toBe(
      at(today, 0).getTime() + 86_400_000,
    );
  });
});

describe('cutoverOf (EN-233, PR-116, ORD-133)', () => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear() - 7, 0, 1));
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const plusDays = (date: Date, days: number) =>
    new Date(date.getTime() + days * 86_400_000);

  it('EN-233: by default, the next clinic day with an edition in force, and the first edition date without one', () => {
    expect(cutoverOf({ requested: undefined, now, editionInForce: true, firstEditionFrom: first })).toEqual(nextClinicDay(now)); // prettier-ignore
    expect(cutoverOf({ requested: undefined, now, editionInForce: false, firstEditionFrom: first })).toEqual(first); // prettier-ignore
  });

  it('EN-233: accepts a later day as AAAA-MM-DD, and refuses one before tomorrow over an edition in force', () => {
    const later = plusDays(nextClinicDay(now), 3);
    expect(cutoverOf({ requested: day(later), now, editionInForce: true, firstEditionFrom: first })).toEqual(later); // prettier-ignore
    expect(
      () =>
      cutoverOf({ requested: day(plusDays(nextClinicDay(now), -2)), now, editionInForce: true, firstEditionFrom: first }), // prettier-ignore
    ).toThrow(/anterior a mañana/);
    // Positive control of the same date without an edition in force.
    expect(cutoverOf({ requested: day(plusDays(nextClinicDay(now), -2)), now, editionInForce: false, firstEditionFrom: first })).toEqual(plusDays(nextClinicDay(now), -2)); // prettier-ignore
  });

  it('EN-233: refuses a date that is not AAAA-MM-DD, rather than an Invalid Date', () => {
    const year = now.getUTCFullYear();
    // Day-first, a February 30th, and words.
    for (const text of [`07-10-${year}`, `${year}-02-30`, 'mañana'])
      expect(() => cutoverOf({ requested: text, now, editionInForce: false, firstEditionFrom: first })).toThrow(/AAAA-MM-DD/); // prettier-ignore
  });
});
