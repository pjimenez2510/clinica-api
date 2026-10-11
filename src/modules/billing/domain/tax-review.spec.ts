import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  clinicalDateOf,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

import { TAX_REVIEW_VALID_MONTHS, taxReviewPending } from './tax-review';

describe('BI-301 la revisión del IVA que caduca, apagada de fábrica', () => {
  const now = new Date();
  const today = clinicalDateOf(now);
  /** Noon in Ecuador, `months` back and `days` more. */
  const reviewedAgo = (months: number, days = 0) => ({
    reviewedAt: new Date(
      startOfClinicalDay(addDays(addMonths(today, -months), -days)).getTime() +
        12 * 3600_000,
    ),
  });

  it('BI-301 de fábrica no hay plazo: una revisión de hace años sigue valiendo', () => {
    expect(TAX_REVIEW_VALID_MONTHS).toBeNull();
    expect(taxReviewPending(reviewedAgo(36), now)).toBe(false);
  });

  it('BI-301 sin revisión, siempre pendiente', () => {
    expect(taxReviewPending(null, now)).toBe(true);
    expect(taxReviewPending(null, now, 12)).toBe(true);
  });

  it('BI-301 con 12 meses, la del mismo día de hace un año vale y la del día anterior cuenta como pendiente', () => {
    expect(taxReviewPending(reviewedAgo(12), now, 12)).toBe(false);
    expect(taxReviewPending(reviewedAgo(12, 1), now, 12)).toBe(true);
  });
});
