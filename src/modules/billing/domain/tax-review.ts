import {
  addMonths,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

/**
 * BI-301 (D-172 §4). How many months a tax review of a service holds before
 * it counts as pending again. `null`: it never expires — the default, until
 * the accountant asks for a yearly review; turning it on is writing 12 here.
 * **Confirmar con:** contador.
 */
export const TAX_REVIEW_VALID_MONTHS: number | null = null;

/**
 * BI-022 to BI-024, BI-301. Whether the service's tax rate still waits for
 * an accountant: never reviewed, or reviewed longer ago than `validMonths`,
 * counted in calendar days of Ecuador (BI-002).
 */
export function taxReviewPending(
  review: { reviewedAt: Date } | null,
  now: Date,
  validMonths: number | null = TAX_REVIEW_VALID_MONTHS,
): boolean {
  if (review === null) return true;
  if (validMonths === null) return false;
  return clinicalDateOf(now) > lastValidDay(review.reviewedAt, validMonths);
}

/**
 * BI-301. The instant before which a review no longer holds, for a query to
 * order by; `null` when reviews do not expire.
 */
export function taxReviewExpiredBefore(
  now: Date,
  validMonths: number | null = TAX_REVIEW_VALID_MONTHS,
): ClinicalDate | null {
  return validMonths === null
    ? null
    : addMonths(clinicalDateOf(now), -validMonths);
}

function lastValidDay(reviewedAt: Date, validMonths: number): ClinicalDate {
  return addMonths(clinicalDateOf(reviewedAt), validMonths);
}
