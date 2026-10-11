import { describe, expect, it } from 'vitest';

import {
  addMonths,
  clinicalDateOf,
  parseClinicalDate,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

import { spendingMonthStart } from './spending';

describe('spendingMonthStart', () => {
  it('AS-017 counts the month in Guayaquil: the last evening of a month is still that month', () => {
    const thisMonth = parseClinicalDate(`${clinicalDateOf(new Date()).slice(0, 8)}01`); // prettier-ignore
    const nextMonthStart = startOfClinicalDay(addMonths(thisMonth, 1));
    // 21:00 of the last day in Guayaquil is 02:00 of the next day in UTC.
    const lastEvening = new Date(nextMonthStart.getTime() - 3 * 3_600_000);

    expect(lastEvening.toISOString().slice(0, 10)).toBe(clinicalDateOf(nextMonthStart)); // prettier-ignore
    expect(spendingMonthStart(lastEvening)).toEqual(startOfClinicalDay(thisMonth)); // prettier-ignore
    expect(spendingMonthStart(nextMonthStart)).toEqual(nextMonthStart);
  });
});
