import {
  addDays,
  isoWeekdayOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

/** LOPDP arts. 13 to 17 and 19. */
export const DATA_SUBJECT_RIGHTS = [
  'ACCESS',
  'RECTIFICATION',
  'ERASURE',
  'OBJECTION',
  'PORTABILITY',
  'SUSPENSION',
] as const;
export type DataSubjectRight = (typeof DATA_SUBJECT_RIGHTS)[number];

/**
 * How long the clinic has to answer one right.
 *
 * `businessDays` is a «término» (COA art. 158): working days. `calendarDays`,
 * when present, is the «plazo de quince (15) días» of LOPDP arts. 13-16, and
 * the earlier of the two wins.
 */
interface DueDateRule {
  businessDays: number;
  calendarDays?: number;
}

/**
 * ⚠️ PROVISIONAL — D-083 §1, OPTION A. A LEGAL DECISION THIS CODE DOES NOT OWN.
 *
 * The law says «plazo de quince (15) días» in arts. 13-16 and «término de diez
 * (10) días» in art. 62, and nothing published reconciles them. Option A takes
 * whichever falls EARLIER, so the clinic is on time under either reading.
 * Portability and automated decisions have no deadline of their own, so the
 * general art. 62 applies; suspension (and revocation of consent) is 3 working
 * days by Res. SPDP-SPD-2025-0030-R arts. 16 and 18.
 *
 * Changing the rule is changing this table. It never moves a deadline already
 * set: `data_subject_request.due_on` is computed once and stored (PD-032).
 */
const RULES: Readonly<Record<DataSubjectRight, DueDateRule>> = {
  ACCESS: { businessDays: 10, calendarDays: 15 },
  RECTIFICATION: { businessDays: 10, calendarDays: 15 },
  ERASURE: { businessDays: 10, calendarDays: 15 },
  OBJECTION: { businessDays: 10, calendarDays: 15 },
  PORTABILITY: { businessDays: 10 },
  SUSPENSION: { businessDays: 3 },
};

/**
 * PD-032. The clinical date by which a request must be answered.
 *
 * Working days are Monday to Friday that are not a holiday of the WHOLE clinic
 * (`clinicWideHolidays`), counted from the day after the request arrived:
 * the day of receipt never counts, whatever time it came in.
 *
 * Pure: the holidays come in as data, so the rule is testable without a base
 * and the caller decides which holidays apply.
 */
export function legalDueDate(
  right: DataSubjectRight,
  receivedOn: ClinicalDate,
  clinicWideHolidays: ReadonlySet<string>,
): ClinicalDate {
  const rule = RULES[right];

  let day = receivedOn;
  let counted = 0;
  while (counted < rule.businessDays) {
    day = addDays(day, 1);
    if (isoWeekdayOf(day) <= 5 && !clinicWideHolidays.has(day)) counted += 1;
  }

  if (rule.calendarDays === undefined) return day;
  const calendar = addDays(receivedOn, rule.calendarDays);
  return calendar < day ? calendar : day;
}

/**
 * The furthest a due date can fall from its receipt, in calendar days: enough
 * holidays to read for any rule. Ten working days span two weeks plus however
 * many holidays fall in them; a month is generous on purpose.
 */
export const DUE_DATE_HORIZON_DAYS = 31;
