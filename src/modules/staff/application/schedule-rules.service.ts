import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/authorisation/principal';
import {
  assertSiteInScope,
  assertSitesInScope,
} from '../../../shared/authorisation/site-scope';
import {
  type ClinicalDate,
  WallClockTime,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import {
  type ScheduleConflict,
  scheduleConflicts,
} from '../domain/schedule-conflicts';
import {
  type ScheduleRuleDraft,
  closeScheduleRuleOn,
  scheduleRuleProblems,
} from '../domain/schedule-rule';
import {
  SCHEDULE_RULE_REPOSITORY,
  type ScheduleRuleRepository,
  type ScheduleRuleView,
} from '../domain/schedule-rule.repository';
import {
  InvalidScheduleRuleError,
  PractitionerNotFoundError,
  PractitionerNotInSiteError,
  PractitionerNotSchedulableError,
  ScheduleRuleNotFoundError,
} from '../domain/staff.errors';

import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/**
 * Every schedule change answers with the appointments it left outside
 * (ST-043). Empty is the normal case and is still returned, so the screen
 * never has to guess whether the list was computed.
 */
export interface ScheduleRuleOutcome {
  rule: ScheduleRuleView;
  conflicts: readonly ScheduleConflict[];
}

/** What a caller may propose. `undefined` means "leave it as it is". */
export interface ScheduleRulePatch {
  siteId?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  validFrom?: ClinicalDate;
  validTo?: ClinicalDate | null;
}

/**
 * Editing a practitioner's schedule from the application (S2, ST-040..ST-046).
 *
 * THE HEADLINE GUARANTEE IS NOT IN THIS FILE. ST-042 — two rules in force for
 * the same practitioner and weekday may not overlap, in any site since D-070 —
 * lives in the base
 * as `schedule_rule_no_overlap`, and it has to: two administrators editing the
 * same doctor's Monday both read "no overlap" and both write. Nothing here
 * checks it first, so nothing here can lose that race.
 *
 * WHAT IS HERE is everything the base cannot answer per field: that the
 * practitioner attends at the site (ST-007), that they take appointments at
 * all (ST-006), that the rule is derivable into slots (ST-045), and — the one
 * that matters most to a patient — the LIST of appointments the change would
 * strand, which is returned and never acted upon (ST-043).
 */
@Injectable()
export class ScheduleRulesService {
  constructor(
    @Inject(SCHEDULE_RULE_REPOSITORY)
    private readonly rules: ScheduleRuleRepository,
    private readonly trail: StaffAuditTrail,
  ) {}

  /** ST-040. Closed rules travel only when explicitly asked for. */
  async list(
    practitionerId: string,
    includeClosed: boolean,
  ): Promise<readonly ScheduleRuleView[]> {
    await this.requireSchedulablePractitioner(practitionerId, false);
    return this.rules.listByPractitioner(practitionerId, includeClosed);
  }

  /**
   * ST-040, ST-041, ST-045, ST-046, ST-048.
   *
   * THE SCOPE CHECK IS THE FIRST THING, before the practitioner is even looked
   * up, and the order is the requirement (ST-048). `PRACTITIONER_NOT_IN_SITE`
   * answers «this doctor does / does not attend at that site», and answering
   * it to somebody who does not hold that site enumerates the clinic's map for
   * whoever guesses identifiers. `SITE_SCOPE_DENIED` names the permission and
   * never a site.
   */
  async create(
    practitionerId: string,
    input: Required<Omit<ScheduleRulePatch, 'validTo'>> & {
      validTo: ClinicalDate | null;
    },
    requester: Requester,
    caller: Principal,
  ): Promise<ScheduleRuleOutcome> {
    assertSiteInScope(caller, 'staff:manage', input.siteId);

    await this.requireSchedulablePractitioner(practitionerId, true);
    await this.requireSiteOfPractitioner(practitionerId, input.siteId);
    await this.requireDerivable(input);

    const rule = await this.rules.create({ practitionerId, ...input });
    await this.trail.record('CREATE', rule.id, requester);

    return { rule, conflicts: await this.conflictsAfter(rule) };
  }

  /**
   * ST-040, ST-041, ST-044. A rule belongs to exactly one site (ST-046), and
   * moving it to another one is allowed only where the practitioner attends.
   *
   * ST-048 JUDGES BOTH ENDS, like ST-047 does with a practitioner's sites.
   * The site the rule ALREADY has was checked by nobody — the body need not
   * even mention a site — so whoever administered Norte could shorten Sur's
   * Monday from a screen. And a `PATCH {"siteId": …}` MOVES the rule: it takes
   * slots away from one site's agenda and hands them to another's, which is
   * two sites changing, so both have to be inside the caller's scope.
   *
   * IT ALSO CLOSES A LEAK OF ST-043. The answer to every mutation lists the
   * appointments the change strands, and on a move that list covers the site
   * the rule LEFT — identifier, day and hour of each one — handed over as a
   * side effect of an edit nobody was entitled to make.
   */
  async update(
    ruleId: string,
    patch: ScheduleRulePatch,
    requester: Requester,
    caller: Principal,
  ): Promise<ScheduleRuleOutcome> {
    const current = await this.requireRule(ruleId);
    assertSitesInScope(caller, 'staff:manage', [
      current.siteId,
      patch.siteId ?? current.siteId,
    ]);

    /**
     * `undefined` means «leave it as it is», and a plain spread does NOT mean
     * that: `{...stored, ...patch}` with `patch.validTo === undefined` erases
     * the stored value. The controller sends every field, absent ones as
     * `undefined`, so this was not hypothetical — a PATCH of `endTime` alone
     * reached the validation with no `validFrom` at all and answered 500.
     */
    const merged = { ...this.draftOf(current), ...definedOf(patch) };

    if (patch.siteId !== undefined && patch.siteId !== current.siteId) {
      await this.requireSiteOfPractitioner(
        current.practitionerId,
        patch.siteId,
      );
    }
    await this.requireDerivable(merged);

    const updated = await this.rules.update(ruleId, definedOf(patch));
    if (!updated) throw new ScheduleRuleNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return {
      rule: updated,
      /**
       * BOTH SITES WHEN THE RULE MOVED, and this is the whole reason the
       * parameter exists. Asking only about the site the rule now lives at
       * answered `{conflicts: []}` to a change that had just left every
       * appointment at the ORIGINAL site covered by no rule at all — the exact
       * situation ST-043 exists to report, reported as "nothing happened".
       */
      conflicts: await this.conflictsAfter(
        updated,
        current.siteId === updated.siteId
          ? [updated.siteId]
          : [current.siteId, updated.siteId],
      ),
    };
  }

  /**
   * ST-041: closing rules FORWARD. Never a delete, and never a retroactive
   * deactivation — the days already past keep the rule the appointments booked
   * on them were justified by, and a schedule that vanished from history would
   * make last month's agenda unexplainable.
   */
  async close(
    ruleId: string,
    requester: Requester,
    caller: Principal,
    on: ClinicalDate = clinicalDateOf(new Date()),
  ): Promise<ScheduleRuleOutcome> {
    const current = await this.requireRule(ruleId);
    // ST-048. Nothing about the site travels in this request — there is no
    // body at all — so it is READ from the row and judged just the same.
    // Closing a schedule empties an agenda; whose agenda it is, is the
    // question the guard could not ask.
    assertSiteInScope(caller, 'staff:manage', current.siteId);

    const closure = closeScheduleRuleOn(this.draftOf(current), on);

    const updated = await this.rules.update(
      ruleId,
      closure.kind === 'CLOSE'
        ? { validTo: closure.validTo }
        : { active: false },
    );
    if (!updated) throw new ScheduleRuleNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return { rule: updated, conflicts: await this.conflictsAfter(updated) };
  }

  /**
   * ST-043. What the change leaves stranded, computed AFTER it is written and
   * against the schedule as it now stands — including the rules this change
   * did not touch, because an appointment covered by the afternoon rule is not
   * a conflict just because the morning one moved.
   *
   * Only from today forward: ST-041 forbids a change from reaching days
   * already past, and an appointment already attended is history, not a
   * conflict somebody can still phone about.
   *
   * `siteIds` is a LIST and not `rule.siteId` because a rule can MOVE (ST-046):
   * after `PATCH {"siteId": …}` the appointments that need looking at are the
   * ones at the site the rule left, which the rule no longer names. Passing
   * both is what makes the answer about the change rather than about the row.
   * `scheduleConflicts` already copes with a mixed-site list — `isCovered`
   * keys on `rule.siteId === entry.siteId`.
   */
  private async conflictsAfter(
    rule: ScheduleRuleView,
    siteIds: readonly string[] = [rule.siteId],
    from: ClinicalDate = clinicalDateOf(new Date()),
  ): Promise<readonly ScheduleConflict[]> {
    const [booked, inForce] = await Promise.all([
      Promise.all(
        siteIds.map((siteId) =>
          this.rules.bookedFrom(rule.practitionerId, siteId, from),
        ),
      ),
      this.rules.listByPractitioner(rule.practitionerId, false),
    ]);

    return scheduleConflicts(
      // Chronological across the sites, so the screen reads as one list of
      // appointments to phone about and not as one list per site.
      booked
        .flat()
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime()), // prettier-ignore
      inForce.map((row) => ({
        siteId: row.siteId,
        weekday: row.weekday,
        startMinutes: WallClockTime.parse(row.startTime).minutesFromMidnight,
        endMinutes: WallClockTime.parse(row.endTime).minutesFromMidnight,
        validFrom: row.validFrom,
        validTo: row.validTo,
        active: row.active,
      })),
    );
  }

  /**
   * ST-045, answered per field before the CHECK constraints are reached.
   *
   * IT IS ASYNC SINCE D-021 because one of the three questions — «¿cabe algún
   * turno en esta franja?» — is about the SITE's grid, not about the rule, and
   * the rule no longer carries a slot length of its own. The read is one row
   * by primary key.
   */
  private async requireDerivable(draft: {
    siteId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    validFrom: ClinicalDate;
    validTo: ClinicalDate | null;
  }): Promise<void> {
    const problems = scheduleRuleProblems(
      {
        weekday: draft.weekday,
        startTime: WallClockTime.parse(draft.startTime),
        endTime: WallClockTime.parse(draft.endTime),
        validFrom: draft.validFrom,
        validTo: draft.validTo,
      },
      await this.rules.slotAtomOfSite(draft.siteId),
    );
    if (problems.length > 0) throw new InvalidScheduleRuleError(problems);
  }

  /** ST-007: no rule in a site where the practitioner does not attend. */
  private async requireSiteOfPractitioner(
    practitionerId: string,
    siteId: string,
  ): Promise<void> {
    if (!(await this.rules.practitionerWorksAt(practitionerId, siteId))) {
      throw new PractitionerNotInSiteError();
    }
  }

  /**
   * ST-006. `requireSchedulable` is false for the LISTING: a practitioner who
   * stopped taking appointments still has a schedule worth reading, and hiding
   * it would make it impossible to see what to close.
   */
  private async requireSchedulablePractitioner(
    practitionerId: string,
    requireSchedulable: boolean,
  ): Promise<void> {
    const schedulable = await this.rules.isSchedulable(practitionerId);
    if (schedulable === null) throw new PractitionerNotFoundError();
    if (requireSchedulable && !schedulable) {
      throw new PractitionerNotSchedulableError();
    }
  }

  /** The stored rule, or `ScheduleRuleNotFoundError`. */
  private async requireRule(ruleId: string): Promise<ScheduleRuleView> {
    const rule = await this.rules.findRule(ruleId);
    if (!rule) throw new ScheduleRuleNotFoundError();
    return rule;
  }

  /**
   * The stored rule's editable fields: what `update` spreads the patch over
   * and what `close` judges. Nothing that says whose rule it is.
   */
  private draftOf(rule: ScheduleRuleView): {
    siteId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    validFrom: ClinicalDate;
    validTo: ClinicalDate | null;
  } & Pick<ScheduleRuleDraft, 'validFrom' | 'validTo'> {
    return {
      siteId: rule.siteId,
      weekday: rule.weekday,
      startTime: rule.startTime,
      endTime: rule.endTime,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
    };
  }
}

/** The keys the caller actually sent. `null` is a value; `undefined` is not. */
function definedOf<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
