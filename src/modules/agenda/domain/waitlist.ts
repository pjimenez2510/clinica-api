import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  type PriorityGroupPeriod,
  type PriorityLevel,
  priorityLevelOf,
} from '../../../shared/domain/priority-level';

/**
 * The waiting list, as decisions (AG-060 to AG-067).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO CLOCK, NO DATABASE, NO FRAMEWORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Today is a PARAMETER. Every question here is «as of which day?», and the day
 * is the Ecuadorian one, resolved by the caller: at 21:00 in Guayaquil the UTC
 * date is already tomorrow, and an entry whose last preferred day is today
 * would be expired half a shift early (AG-001, AG-065).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BASE COUNTS, THE DOMAIN DECIDES — the pattern E6 already used
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The adapter brings the raw facts of the OPEN entries of one site: the two
 * preferred dates, the practitioner and the service type if the entry fixes
 * them, how many contact attempts it has, the patient's birth date and the
 * periods of the priority groups in force. Every RULE — which entries are
 * compatible, which have lapsed, who goes first — is decided here, where a
 * test can name the requirement. A `WHERE preferred_to >= current_date` in the
 * query would be a second copy of AG-065 that no unit test could break, and
 * the site's cap would be spelled out in SQL where D-040 cannot reach it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE AGENDA NEVER SEES THE MOTIVE (PA-042, AG-073)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `priorityLevelOf` takes PERIODS and no group code, so nothing in this file —
 * or in the query that feeds it — can name WHY somebody is prioritised. That
 * is not a convention to remember while mapping a response: the datum never
 * leaves the database. It is what lets E5 work with `patient:read`, while the
 * four groups of the second sentence of article 35 stay behind
 * `patient:priority:protected` where D-027 put them.
 */

export type WaitlistStatus =
  'WAITING' | 'CONTACTED' | 'SCHEDULED' | 'EXPIRED' | 'CANCELLED';

/** AG-064. What happened on a call: nobody answered, they took it, they said no. */
export type WaitlistContactOutcome = 'NO_ANSWER' | 'ACCEPTED' | 'DECLINED';

export const WAITLIST_CONTACT_OUTCOMES: readonly WaitlistContactOutcome[] = [
  'NO_ANSWER',
  'ACCEPTED',
  'DECLINED',
];

/**
 * AG-067. The two statuses that still compete for a slot.
 *
 * It is the predicate of `waitlist_entry_open_candidates`, the partial index
 * the migration created, written once more where the rule is decided. The
 * index accelerates the right query; it does not prevent the wrong one, and
 * `trg_waitlist_entry_closure_final` guarantees the other half — that a closed
 * entry cannot be reopened and re-enter the queue with its original seniority.
 */
export const OPEN_WAITLIST_STATUSES = ['WAITING', 'CONTACTED'] as const;

export function isOpenWaitlistStatus(status: WaitlistStatus): boolean {
  return (OPEN_WAITLIST_STATUSES as readonly WaitlistStatus[]).includes(status);
}

/**
 * The maximum number of contact attempts a site allows (AG-066, AG-094).
 *
 * ⚠️ D-040 (a) IS OPEN AND THE NUMBER IS NOT OURS. The column exists, it is a
 * site parameter and it can be changed without deploying code (REQ-145), so
 * the starting value costs a screen rather than a migration. What is written
 * here is only the fallback for a site with no parameter row at all, and it
 * matches the column default the migration wrote.
 */
export interface WaitlistSiteParameters {
  maxContactAttempts: number;
}

export const DEFAULT_WAITLIST_PARAMETERS: WaitlistSiteParameters = {
  maxContactAttempts: 3,
};

export type StoredWaitlistParameters = Partial<WaitlistSiteParameters>;

/**
 * AG-095 applied to this parameter: the site's value first, the code default
 * for what it does not state.
 *
 * `??` and not `||`, like `resolveBookingParameters`: the CHECK constraint
 * refuses `0`, but writing the falsy test here would be the same bug waiting
 * for the day a parameter admits it.
 */
export function resolveWaitlistParameters(
  stored: StoredWaitlistParameters | null,
): WaitlistSiteParameters {
  return {
    maxContactAttempts:
      stored?.maxContactAttempts ?? DEFAULT_WAITLIST_PARAMETERS.maxContactAttempts, // prettier-ignore
  };
}

/**
 * What the patient half of a candidate contributes to the ORDER, and nothing
 * else.
 *
 * TWO DATE COLUMNS AND A BIRTH DATE. No name, no document, no group code: the
 * proposal is a list of identifiers a receptionist calls, and the reason
 * somebody is prioritised is not part of it (AG-073, AG-074, SC-006).
 */
export interface CandidatePatientFacts {
  birthDate: ClinicalDate;
  /**
   * PA-055. The periods of the chart AND of the charts it absorbed. A
   * pregnancy recorded on a duplicate that was merged away still prioritises
   * the survivor — it is the same person, and the merge is not a clinical
   * event.
   */
  periods: readonly PriorityGroupPeriod[];
  /**
   * PA-043, AG-027. This chart was itself merged INTO another one.
   *
   * Such an entry cannot become an appointment: booking for a merged chart is
   * refused (AG-027), and `trg_waitlist_entry_conversion_consented` demands
   * the appointment be of the SAME chart the entry hangs on. Proposing it
   * would be offering a slot that cannot be taken.
   */
  chartMergedAway: boolean;
}

/** One open entry, reduced to what AG-061 needs to decide. */
export interface WaitlistCandidate {
  id: string;
  patientId: string;
  status: WaitlistStatus;
  /** AG-061: the second criterion — seniority of enrolment. */
  enrolledAt: Date;
  preferredFrom: ClinicalDate;
  preferredTo: ClinicalDate;
  /** `null` = any practitioner (AG-060). */
  practitionerId: string | null;
  /** `null` = any type of attention (AG-060). */
  serviceTypeId: string | null;
  /** AG-066. Derived from `waitlist_contact_attempt`, never from a column. */
  contactAttempts: number;
  /** AG-064. Derived from the same trail: `max(attempted_at)`, or `null`. */
  lastContactedAt: Date | null;
  patient: CandidatePatientFacts;
}

/**
 * The slot that just came free (AG-061).
 *
 * A CLINICAL DATE AND NOT AN INSTANT, because that is what the entry states:
 * `preferred_from`–`preferred_to` are calendar days, and the day an 08:00
 * appointment falls on is decided in `America/Guayaquil` by the caller, never
 * by whatever zone the host happens to run in.
 */
export interface FreedSlot {
  date: ClinicalDate;
  practitionerId: string;
  /** `null` when the freed entry fixed none — a released block, typically. */
  serviceTypeId: string | null;
}

/**
 * AG-061. Whether this entry can take that slot.
 *
 * «Misma sede» is not checked here and is not missing: the query asks for the
 * open entries OF ONE SITE and the route is scoped by `param:siteId`
 * (AG-071), so an entry of another site never reaches this function. The
 * remaining three are the ones an entry can state or leave open, and an
 * unstated one means «cualquiera» — which is what makes the absence of a
 * practitioner a WIDER match rather than a narrower one.
 */
export function isCompatibleWith(
  entry: WaitlistCandidate,
  slot: FreedSlot,
): boolean {
  if (entry.preferredFrom > slot.date || entry.preferredTo < slot.date) {
    return false;
  }
  if (
    entry.practitionerId !== null &&
    entry.practitionerId !== slot.practitionerId
  ) {
    return false;
  }
  if (
    entry.serviceTypeId !== null &&
    entry.serviceTypeId !== slot.serviceTypeId
  ) {
    // prettier-ignore
    return false;
  }
  return true;
}

/**
 * AG-061. The freed hour has already gone, so there is nothing to offer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SLOT THAT PASSED IS NOT A SLOT — and offering it costs a real call
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An appointment cancelled this morning was still being proposed in the
 * afternoon: the queue named somebody, reception phoned them, they accepted,
 * and booking refused the hour (AG-031). The list led the receptionist to a
 * wall, and on the way it spent a call to a real person and one of the
 * attempts that entry has before it expires (AG-066). Neither is undoable —
 * `waitlist_contact_attempt` is append-only.
 *
 * THE INSTANT, NOT THE DAY, and `now` is a parameter like every other question
 * in this file. The day is what `preferred_from`–`preferred_to` speak, and it
 * is too coarse here: 08:00 and 19:00 of today are the same date and only one
 * of them can still be given at noon.
 *
 * ⚠️ STRICTLY BEFORE, WHICH IS HOW AG-031 READS THE SAME FACT
 * (`checkBookingWindow`: «a start AT the current instant is the counter
 * booking that D-001 set the minimum lead to zero for»). So the slot starting
 * five minutes from now is offered, the one that started a minute ago is not,
 * and the one starting AT this instant is offered — because the booking that
 * closes the flow would accept it. Reading the border the other way would hide
 * a slot the system does let somebody take; reading it more strictly still —
 * adding a margin — would be inventing a minimum lead the site did not ask
 * for, and AG-032 already owns that number.
 *
 * NOT CONDITIONED ON `allow_past_booking`, which is the parameter AG-031 obeys
 * (`site_parameter`). That switch exists so a site can RECORD an attention
 * that already happened, and a retroactive record never travels through the
 * waiting list: proposing a candidate is a call asking somebody to come. A
 * slot nobody can attend is nothing to offer, whatever the site admits typing
 * in afterwards.
 */
export function hasSlotPassed(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() < now.getTime();
}

/**
 * AG-065. The last preferred day is already in the past.
 *
 * STRICTLY BEFORE TODAY: «del 3 al 3» is a legitimate range and the 3rd itself
 * still counts, exactly as `waitlist_entry_preferred_range_valid` reads it and
 * as `isPeriodInForce` treats a priority period.
 */
export function hasLapsed(
  entry: Pick<WaitlistCandidate, 'preferredTo'>,
  today: ClinicalDate,
): boolean {
  return entry.preferredTo < today;
}

/**
 * AG-066. The entry has used up the site's contact attempts.
 *
 * ⚠️ EVERY ATTEMPT COUNTS, WHATEVER ITS OUTCOME, and that is the requirement
 * as written — «alcanza el número máximo de INTENTOS de contacto de la sede».
 * D-040 (b) asks whether a patient who answers and DECLINES should be spared
 * that count, and recommends they should; until the clinic answers, changing
 * it is this one predicate and its test, with no migration and no change to
 * anything that calls it. That is the whole reason the rule is a function
 * rather than a `WHERE` clause.
 */
export function hasExhaustedContactAttempts(
  attempts: number,
  parameters: WaitlistSiteParameters,
): boolean {
  return attempts >= parameters.maxContactAttempts;
}

/**
 * AG-065, AG-066. Which of the open entries must be closed, RIGHT NOW.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THEY ARE ACTS, NOT SHAPES A ROW CAN HAVE — so somebody has to perform them
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No constraint can mark a row `EXPIRED` because nothing HAPPENS when a date
 * passes: the clock moves and the database is not told. So the act is
 * performed by every use case that could otherwise act on a lapsed entry —
 * proposing candidates, listing the waiting list, recording a contact — before
 * it does anything else, and in the same transaction.
 *
 * WHY NOT A SCHEDULED JOB. It is the answer that depends on somebody
 * remembering: to configure it, to keep it running, to notice the night it
 * did not. A missed run means a woman whose preferred fortnight ended in July
 * still competing for October's slots with her original seniority, and nothing
 * red anywhere. Resolving it where the state is read cannot be forgotten,
 * because the only way to observe the difference is to perform the read that
 * fixes it first. It is the same argument PA-036 makes for a pregnancy that
 * stops counting «sin que nadie tenga que cerrarlo a mano» — with one
 * difference that is the requirement's, not ours: AG-065 says the entry SHALL
 * be MARKED, so this one writes.
 */
export function entriesToExpire(
  open: readonly WaitlistCandidate[],
  today: ClinicalDate,
  parameters: WaitlistSiteParameters,
): readonly string[] {
  return open
    .filter(
      (entry) =>
        isOpenWaitlistStatus(entry.status) &&
        (hasLapsed(entry, today) ||
          hasExhaustedContactAttempts(entry.contactAttempts, parameters)),
    )
    .map((entry) => entry.id);
}

/**
 * A candidate, with the number that orders it.
 *
 * `priority` is `1` or `2` and says WHO GOES FIRST and nothing else — the same
 * field every response carrying a patient already has (PA-041, PA-042).
 */
export interface RankedCandidate {
  entryId: string;
  patientId: string;
  priority: PriorityLevel;
  status: WaitlistStatus;
  enrolledAt: Date;
  practitionerId: string | null;
  serviceTypeId: string | null;
  preferredFrom: ClinicalDate;
  preferredTo: ClinicalDate;
  contactAttempts: number;
  lastContactedAt: Date | null;
}

/**
 * AG-061, AG-062, AG-067. Who is offered the freed slot, in what order.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PRIORITY IS DERIVED HERE AND NOW, NEVER READ FROM A COLUMN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `waitlist_entry.priority` existed and was dropped by
 * `agenda_waitlist_contact_trail`, because a number frozen at enrolment is the
 * defect PA-036 exists to prevent: the woman who has given birth stays
 * priority 1 for ever, and the adolescent who turns 18 too. Worse than on the
 * chart, where a stale datum is at least visible — here it silently orders a
 * queue. So the level is computed against TODAY from the periods in force,
 * with the same function `patients` uses (`shared/domain/priority-level.ts`),
 * and the two cannot disagree about the same person on the same day.
 *
 * TIES BROKEN BY SENIORITY, which is the second criterion of AG-061 and the
 * one fact that IS in the past: `created_at`. Enrolment instants come from
 * `now()` on one database, so a tie between two of them means the same
 * microsecond; the entry id decides it so the order is total and the answer
 * to «¿por qué ella y no yo?» does not change between two identical calls.
 */
export function rankCandidates(
  open: readonly WaitlistCandidate[],
  slot: FreedSlot,
  today: ClinicalDate,
): readonly RankedCandidate[] {
  return rankWaiting(
    open.filter((entry) => isCompatibleWith(entry, slot)),
    today,
  );
}

/**
 * AG-062, AG-065, AG-067. The same order, without a slot to fit.
 *
 * It is what the waiting list of a site LOOKS like — who is ahead of whom
 * today — and it is the half of the ordering that does not depend on which
 * slot came free. `rankCandidates` is this plus AG-061's compatibility, so the
 * two answers cannot put the same two people in a different order.
 */
export function rankWaiting(
  open: readonly WaitlistCandidate[],
  today: ClinicalDate,
): readonly RankedCandidate[] {
  return (
    open
      .filter((entry) => isOpenWaitlistStatus(entry.status))
      // AG-065, AG-066 restated as a filter, not as a second copy of the rule:
      // the caller expires these in the same transaction, and reading them out
      // here means a write that failed cannot put a closed entry back in the
      // queue.
      .filter((entry) => !hasLapsed(entry, today))
      // PA-043. A chart merged into another cannot take the slot — see
      // `chartMergedAway`.
      .filter((entry) => !entry.patient.chartMergedAway)
      .map((entry) => ({
        entryId: entry.id,
        patientId: entry.patientId,
        priority: priorityLevelOf(entry.patient, today),
        status: entry.status,
        enrolledAt: entry.enrolledAt,
        practitionerId: entry.practitionerId,
        serviceTypeId: entry.serviceTypeId,
        preferredFrom: entry.preferredFrom,
        preferredTo: entry.preferredTo,
        contactAttempts: entry.contactAttempts,
        lastContactedAt: entry.lastContactedAt,
      }))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.enrolledAt.getTime() - b.enrolledAt.getTime() ||
          (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
      )
  );
}

/**
 * AG-064, AG-066. What the entry becomes once this attempt is recorded.
 *
 * ⚠️ `ACCEPTED` DOES NOT CLOSE ANYTHING HERE, and that is the second half of
 * AG-064. An acceptance is the CONFIRMATION that authorises converting the
 * entry into an appointment; the entry becomes `SCHEDULED` when the
 * appointment exists and is linked, in one act the database arbitrates
 * (`waitlist_entry_conversion_complete`). Closing it on the acceptance alone
 * would leave the patient off the list holding no appointment.
 *
 * ⚠️ NEITHER DOES `DECLINED`. D-040 (b) is open — «sigue esperando», «se
 * cierra», or «sigue esperando y el rechazo cuenta» — and the entry keeping
 * its place is what the requirements say today: nothing in AG-060 to AG-067
 * closes an entry because the patient turned one slot down. Closing it would
 * be answering D-040 by writing code.
 *
 * `attemptsAfter` is the count INCLUDING this attempt, which is what «alcanza
 * el número máximo» means.
 */
export function statusAfterContact(
  attemptsAfter: number,
  parameters: WaitlistSiteParameters,
): Extract<WaitlistStatus, 'CONTACTED' | 'EXPIRED'> {
  return hasExhaustedContactAttempts(attemptsAfter, parameters)
    ? 'EXPIRED'
    : 'CONTACTED';
}
