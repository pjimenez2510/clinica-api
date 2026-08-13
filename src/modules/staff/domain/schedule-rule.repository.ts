import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { BookedInterval } from './schedule-conflicts';

/**
 * What editing a practitioner's schedule needs from storage (ST-040..ST-046).
 *
 * A SEPARATE PORT FROM `StaffRepository`, and not for size: the two have
 * different reasons to change. The profile answers to the habilitación and the
 * catalogue; the schedule answers to the exclusion constraint and to what the
 * agenda derives from it. Nothing here overlaps with anything there.
 *
 * WHAT IS DELIBERATELY ABSENT: `wouldOverlap()`. ST-042 lives in the base as
 * `schedule_rule_no_overlap`, and a method that answered it would be a read
 * that is stale before it returns — which is the exact bug the EXCLUDE exists
 * to make impossible.
 */

/** A schedule rule as the administration screen lists it. */
export interface ScheduleRuleView {
  id: string;
  practitionerId: string;
  siteId: string;
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** `HH:MM`, wall clock. Never an instant: this is "Mondays from 08:00". */
  startTime: string;
  endTime: string;
  slotMinutes: number;
  validFrom: ClinicalDate;
  /** `null` means still in force (ST-041). */
  validTo: ClinicalDate | null;
  active: boolean;
}

export interface ScheduleRuleWrite {
  practitionerId: string;
  siteId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  validFrom: ClinicalDate;
  validTo: ClinicalDate | null;
}

export interface ScheduleRuleRepository {
  listByPractitioner(
    practitionerId: string,
    includeClosed: boolean,
  ): Promise<readonly ScheduleRuleView[]>;

  findRule(id: string): Promise<ScheduleRuleView | null>;

  /**
   * ST-040. Nothing is checked for overlap first: PostgreSQL arbitrates and
   * the refusal reaches the client as `SCHEDULE_RULE_OVERLAP` (ST-042).
   */
  create(rule: ScheduleRuleWrite): Promise<ScheduleRuleView>;

  /** `null` when the row is gone. */
  update(
    id: string,
    patch: Partial<Omit<ScheduleRuleWrite, 'practitionerId'>> & {
      active?: boolean;
    },
  ): Promise<ScheduleRuleView | null>;

  /** ST-007: whether the practitioner attends at that site at all. */
  practitionerWorksAt(practitionerId: string, siteId: string): Promise<boolean>;

  /** ST-006: a non-schedulable practitioner admits no new rule. */
  isSchedulable(practitionerId: string): Promise<boolean | null>;

  /**
   * ST-043. Appointments of this practitioner, at this site, still standing
   * from `from` onwards. Released and cancelled entries are excluded — a freed
   * slot is not a conflict, it is a free slot — and so are blocks, which is
   * what `kind` distinguishes.
   *
   * OVERBOOKINGS ARE INCLUDED. An urgent case squeezed in outside the calendar
   * (`blocks_calendar = false`) is a patient who is expecting to be seen, so
   * it is one of the appointments a schedule change strands; the adapter's
   * comment explains why the agenda's exclusion predicate does not transfer.
   *
   * Asked once per site. The caller passes the site the rule LEFT as well when
   * a rule moved, which is why this takes one site and not the rule.
   */
  bookedFrom(
    practitionerId: string,
    siteId: string,
    from: ClinicalDate,
  ): Promise<readonly BookedInterval[]>;
}

export const SCHEDULE_RULE_REPOSITORY = Symbol('ScheduleRuleRepository');
