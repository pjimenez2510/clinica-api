import {
  type ClinicalDate,
  WallClockTime,
  clinicalDaySpan,
} from '../../../shared/domain/clinic-time';

/**
 * What a schedule rule must satisfy, and what closing one means (ST-041,
 * ST-045, ST-046).
 *
 * MOST OF WHAT IS HERE IS ALSO A CONSTRAINT IN THE BASE, and that is
 * deliberate, not redundant. `schedule_rule_time_order` and
 * `schedule_rule_validity_not_empty` are the guarantee — they hold for a seed,
 * a data import and a `psql` at two in the morning. What lives here is the
 * mirror that answers PER FIELD before the base is reached, because "violates
 * check constraint schedule_rule_time_order" is not a sentence an
 * administrator can act on.
 *
 * THE ONE THAT HAS NO CONSTRAINT BEHIND IT IS «EL TURNO CABE» (D-021,
 * 14-08-2026). It used to be `schedule_rule_slot_fits`, reading the rule's own
 * `slot_minutes`; that column is gone and the grid is now one atom per site,
 * which a `CHECK` cannot reach. So this file is the only thing standing
 * between an administrator and a rule that produces no slots at all — see the
 * migration `20260813031542_staff_schedule_rule_no_overlap`, where the
 * trade-off is written down.
 */

/** The shape a rule is proposed in, before it is a row. */
export interface ScheduleRuleDraft {
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  startTime: WallClockTime;
  endTime: WallClockTime;
  validFrom: ClinicalDate;
  /** `null` means it stays in force indefinitely. */
  validTo: ClinicalDate | null;
}

/** One thing wrong with a draft, named by the field the screen must highlight. */
export interface ScheduleRuleProblem {
  field: 'weekday' | 'endTime' | 'validTo';
  message: string;
}

/**
 * Everything wrong with a draft, in one pass.
 *
 * ALL OF THEM AND NOT THE FIRST: an administrator fixing a form one refusal at
 * a time is how a two-field mistake becomes three round trips.
 */
export function scheduleRuleProblems(
  draft: ScheduleRuleDraft,
  /**
   * D-021. The site's slot atom, or `null` when the site declares none. It is
   * a PARAMETER and not a constant because the grid belongs to the site, and
   * the rule now says only WHEN the practitioner works.
   */
  slotAtomMinutes: number | null,
): ScheduleRuleProblem[] {
  const problems: ScheduleRuleProblem[] = [];

  if (
    !Number.isInteger(draft.weekday) ||
    draft.weekday < 1 ||
    draft.weekday > 7
  ) {
    problems.push({
      field: 'weekday',
      message: 'Elija un día de la semana, de lunes a domingo',
    });
  }

  const span =
    draft.endTime.minutesFromMidnight - draft.startTime.minutesFromMidnight;

  // ST-045, first half. Mirrors `schedule_rule_time_order`.
  if (span <= 0) {
    problems.push({
      field: 'endTime',
      message: 'La hora de fin debe ser posterior a la de inicio',
    });
  }

  // ST-045, second half, and the reason it exists: a rule of 08:00–08:15 on a
  // site with a 20-minute grid passes every ordering check and produces NOT
  // ONE slot. On screen that is a practitioner with no agenda and nothing
  // saying why.
  //
  // THE FIELD IS `endTime` SINCE D-021, and that is the honest answer rather
  // than a fallback: the slot length is no longer a field of this form, so the
  // only thing the administrator can change here is where the band ends. The
  // other way out — widening the site's grid — is another screen's, and the
  // message must not send them to it for a band they can simply extend.
  if (slotAtomMinutes !== null && span > 0 && span < slotAtomMinutes) {
    problems.push({
      field: 'endTime',
      message: `La franja de ${span} minutos no da para ningún turno de ${slotAtomMinutes} minutos`,
    });
  }

  // ST-041. Mirrors `schedule_rule_validity_not_empty`: an empty daterange
  // overlaps nothing, so such a rule would also slip past the ST-042
  // exclusion — a rule the base accepts and that means nothing at all.
  //
  // `validTo` IS THE LAST DAY THE RULE RULES, INCLUSIVE. That is what it has
  // meant since E1 (`slot-availability.ts` reads `date <= rule.validTo`), so
  // `validTo === validFrom` is a legitimate one-day rule and only a fin BEFORE
  // the inicio is empty. `clinicalDaySpan` counts inclusively and answers 0 for
  // an inverted range.
  if (
    draft.validTo !== null &&
    clinicalDaySpan(draft.validFrom, draft.validTo) === 0
  ) {
    problems.push({
      field: 'validTo',
      message: 'El fin de vigencia no puede ser anterior al inicio',
    });
  }

  return problems;
}

/**
 * What closing a rule on a given day means (ST-041).
 *
 * "El cierre DEBERÁ regir hacia adelante sin tocar días ya pasados", so a
 * closure is NEVER a delete and never a retroactive deactivation: `valid_to`
 * becomes TODAY — the last day the rule rules, inclusive — and every day before
 * it stays exactly as it was. Closing a schedule must not cancel the morning
 * that is already half over, and the appointments already booked against past
 * days keep the rule that justified them.
 *
 * THE ONE CASE THAT IS NOT A CLOSURE: a rule whose validity has not begun yet.
 * Ending it "today" would put the fin before the inicio — which the base
 * refuses — and there are no past days to protect, because it never ruled over
 * one. Deactivating it is the honest answer, and it is still not a delete.
 */
export type ScheduleRuleClosure =
  { kind: 'CLOSE'; validTo: ClinicalDate } | { kind: 'DEACTIVATE' };

/** ST-041. The closure above, decided for one rule on one Ecuadorian date. */
export function closeScheduleRuleOn(
  rule: Pick<ScheduleRuleDraft, 'validFrom' | 'validTo'>,
  on: ClinicalDate,
): ScheduleRuleClosure {
  // The rule has not started yet: there is nothing to close forward.
  if (clinicalDaySpan(rule.validFrom, on) === 0) {
    return { kind: 'DEACTIVATE' };
  }
  // Already closed earlier than today: leave the earlier date alone rather than
  // extending a schedule somebody deliberately ended.
  if (rule.validTo !== null && clinicalDaySpan(rule.validTo, on) > 1) {
    return { kind: 'CLOSE', validTo: rule.validTo };
  }
  return { kind: 'CLOSE', validTo: on };
}

/**
 * Whether the rule rules on that date.
 *
 * `validTo` INCLUSIVE, matching `slot-availability.ts` and the `[]` bound of
 * the generated `validity` column. Reading it as exclusive here would mean the
 * agenda and the exclusion constraint disagreed about one day per rule — the
 * kind of gap that shows up as a slot offered and then refused.
 */
export function isInForceOn(
  rule: Pick<ScheduleRuleDraft, 'validFrom' | 'validTo'>,
  date: ClinicalDate,
): boolean {
  if (clinicalDaySpan(rule.validFrom, date) === 0) return false;
  return rule.validTo === null || clinicalDaySpan(date, rule.validTo) > 0;
}
