import { describe, expect, it } from 'vitest';

import { nextClinicDay } from './cutover';

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
