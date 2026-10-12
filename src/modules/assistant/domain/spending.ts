import {
  clinicalDateOf,
  parseClinicalDate,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

/**
 * AS-017. The first instant of the calendar month, in America/Guayaquil, in
 * which `at` falls. The 31st at 21:00 in Guayaquil is already the 1st in UTC:
 * the month of spending is the clinic's, never the server's.
 */
export function spendingMonthStart(at: Date): Date {
  return startOfClinicalDay(
    parseClinicalDate(`${clinicalDateOf(at).slice(0, 8)}01`),
  );
}
