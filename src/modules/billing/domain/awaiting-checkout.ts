import {
  addDays,
  clinicalDateOf,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

/**
 * BI-181. How many clinic days back caja looks for visits still owed,
 * counting today.
 *
 * SEVEN AND NOT ONE. The afternoon consultation nobody took to the counter has
 * to be there the next morning: a list that empties at midnight loses exactly
 * what was left uncharged, and it does so without an error.
 */
export const AWAITING_CHECKOUT_DAYS = 7;

/**
 * BI-181, BI-002. The first instant of the window: midnight IN ECUADOR of the
 * sixth day before today's clinic date. At 21:00 in Guayaquil the UTC date is
 * already tomorrow, and a window counted from it would drop a whole day.
 */
export function awaitingCheckoutSince(now: Date): Date {
  return startOfClinicalDay(
    addDays(clinicalDateOf(now), -(AWAITING_CHECKOUT_DAYS - 1)),
  );
}
