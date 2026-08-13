import {
  type ClinicalDate,
  WallClockTime,
  clinicalDaySpan,
} from '../../../shared/domain/clinic-time';

/**
 * What a schedule rule must satisfy, and what closing one means (ST-041,
 * ST-045, ST-046).
 *
 * EVERY RULE HERE IS ALSO A CONSTRAINT IN THE BASE, and that is deliberate,
 * not redundant. `schedule_rule_time_order`, `schedule_rule_slot_positive`,
 * `schedule_rule_slot_fits` and `schedule_rule_validity_not_empty` are the
 * guarantee — they hold for a seed, a data import and a `psql` at two in the
 * morning. What lives here is the mirror that answers PER FIELD before the
 * base is reached, because "violates check constraint schedule_rule_slot_fits"
 * is not a sentence an administrator can act on.
 */

/** The shape a rule is proposed in, before it is a row. */
export interface ScheduleRuleDraft {
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  startTime: WallClockTime;
  endTime: WallClockTime;
  slotMinutes: number;
  validFrom: ClinicalDate;
  /** `null` means it stays in force indefinitely. */
  validTo: ClinicalDate | null;
}

/** One thing wrong with a draft, named by the field the screen must highlight. */
export interface ScheduleRuleProblem {
  field: 'weekday' | 'endTime' | 'slotMinutes' | 'validTo';
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

  if (!Number.isInteger(draft.slotMinutes) || draft.slotMinutes <= 0) {
    problems.push({
      field: 'slotMinutes',
      message: 'Los minutos por turno deben ser un número mayor que cero',
    });
  } else if (span > 0 && draft.slotMinutes > span) {
    // ST-045, second half, and the reason it exists: a rule of 08:00–08:15
    // with 20-minute slots passes every ordering check and produces NOT ONE
    // slot. On screen that is a practitioner with no agenda and nothing saying
    // why. Mirrors `schedule_rule_slot_fits`.
    problems.push({
      field: 'slotMinutes',
      message: `Los turnos de ${draft.slotMinutes} minutos no caben en una franja de ${span} minutos`,
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
