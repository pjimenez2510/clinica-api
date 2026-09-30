import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  StoredWaitlistParameters,
  WaitlistCandidate,
  WaitlistContactOutcome,
  WaitlistStatus,
} from './waitlist';

/**
 * What the waiting list needs from storage, stated without naming a database.
 *
 * A PORT OF ITS OWN, and not seven more methods on `AgendaRepository`. The
 * waiting list is a different aggregate: it is written by different people at
 * a different moment, it shares no method with booking, and it changes for
 * different reasons — D-040 can move what «agotar los intentos» means without
 * touching a single rule about overlapping appointments (ADR-008 §2). The two
 * doubles the unit suites build stay honest instead of growing seven stubs
 * apiece that no test in them exercises.
 *
 * WHAT IS DELIBERATELY ABSENT: anything that decides. There is no
 * `candidatesFor(slot)` that filters by the preferred range or orders by
 * priority, because AG-061, AG-062, AG-065, AG-066 and AG-067 are decided in
 * `waitlist.ts` where a test names each of them. The base counts, the domain
 * decides — the same shape E6 settled on for the no-show cube.
 */

// Re-exported for the same reason `agenda.repository.ts` re-exports its own
// domain types: an adapter or a double should not have to know which file the
// waiting list's shapes happen to live in.
export type {
  StoredWaitlistParameters,
  WaitlistCandidate,
  WaitlistContactOutcome,
  WaitlistStatus,
} from './waitlist';

/**
 * AG-060. What an enrolment carries: site, chart, the preferred range, and
 * OPTIONALLY a practitioner and a type of attention.
 *
 * The two dates are NOT optional and the database refuses them null since
 * `agenda_waitlist_contact_trail`: an entry with no upper bound never satisfies
 * AG-065 and competes for every slot of the site for ever.
 */
export interface NewWaitlistEntry {
  siteId: string;
  patientId: string;
  preferredFrom: ClinicalDate;
  preferredTo: ClinicalDate;
  practitionerId: string | null;
  serviceTypeId: string | null;
}

/**
 * One entry as every route of E5 returns it.
 *
 * NO PATIENT NAME AND NO REASON, exactly like `AgendaEntryView`: the chart
 * identifier only. The screen that needs the name asks the patient register,
 * and that request is the one that leaves an audit row (AG-072, AG-073).
 *
 * `contactAttempts` and `lastContactedAt` are DERIVED from
 * `waitlist_contact_attempt` and are not columns any more — two statements of
 * one fact can only drift, and the cached one is the one that can be short.
 */
export interface WaitlistEntryView {
  id: string;
  siteId: string;
  patientId: string;
  practitionerId: string | null;
  serviceTypeId: string | null;
  preferredFrom: ClinicalDate;
  preferredTo: ClinicalDate;
  status: WaitlistStatus;
  /** AG-063. The appointment this entry became, or `null`. */
  convertedEntryId: string | null;
  contactAttempts: number;
  lastContactedAt: Date | null;
  /** AG-061. Seniority of enrolment, the tie-breaker. */
  createdAt: Date;
}

/** AG-071. An entry is always looked up inside a site, never by id alone. */
export interface WaitlistEntryQuery {
  siteId: string;
  entryId: string;
}

/** AG-064. One call, as it is written down. */
export interface NewContactAttempt {
  entryId: string;
  outcome: WaitlistContactOutcome;
  /** From the session, never from the body: a trail nobody answers for is useless. */
  recordedById: string;
  /**
   * AG-064, AG-066. What the entry becomes, decided by `statusAfterContact` in
   * the domain and applied in the SAME transaction as the attempt.
   *
   * THE DECISION TRAVELS, THE ADAPTER DOES NOT TAKE IT. Counting the rows in
   * SQL and comparing them there would put AG-066 — and with it the site's cap,
   * which D-040 may still change — in a place no unit test can reach.
   */
  status: Extract<WaitlistStatus, 'CONTACTED' | 'EXPIRED'>;
}

/** AG-063. The link that closes an entry, and the appointment it closes on. */
export interface WaitlistConversion {
  entryId: string;
  appointmentId: string;
}

// The port described at the top of this file.
export interface WaitlistRepository {
  /**
   * AG-060. Writes the enrolment.
   *
   * IT DOES NOT CHECK THAT NO SLOT IS FREE, and cannot: AG-060 opens «CUANDO
   * no haya cupo disponible en el rango solicitado», which is the SITUATION
   * that brings somebody to the counter, not a condition a server can verify —
   * a slot free this second is taken the next, and the patient may be turning
   * one down for reasons the grid knows nothing about. Refusing an enrolment
   * because the system found a slot would refuse the ones that matter most.
   */
  enrolInWaitlist(entry: NewWaitlistEntry): Promise<WaitlistEntryView>;
  /**
   * AG-066, AG-094, AG-095: the site's cap on contact attempts, or `null` when
   * the site has no parameter row at all — the domain then falls back to the
   * code default, like every other parameter.
   */
  waitlistParametersFor(siteId: string): Promise<StoredWaitlistParameters | null>; // prettier-ignore
  /**
   * AG-061, AG-067. The OPEN entries of one site with the raw facts the rules
   * need: the preferred range, what the entry fixes, how many attempts it has,
   * and the patient's birth date and priority PERIODS.
   *
   * ONLY `WAITING` AND `CONTACTED`, which is the predicate of the partial index
   * `waitlist_entry_open_candidates` and of AG-067. Everything else — which
   * entries fit the slot, which have lapsed, who goes first — is decided in
   * the domain: the base counts, the domain decides.
   *
   * ⚠️ NO GROUP CODE IS SELECTED. The level depends on WHETHER a period is in
   * force and never on WHICH one, so the motive is not in the query at all
   * (PA-042, AG-073). The periods come through the chart scope, so a pregnancy
   * recorded on an absorbed duplicate still prioritises the survivor (PA-055).
   */
  openWaitlistEntriesFor(siteId: string): Promise<readonly WaitlistCandidate[]>;
  /**
   * AG-065, AG-066. Closes the entries the domain decided have lapsed.
   *
   * Idempotent by construction: it only touches rows still open, so a second
   * call over the same ids writes nothing — and `trg_waitlist_entry_closure_final`
   * would refuse it anyway.
   */
  expireWaitlistEntries(entryIds: readonly string[]): Promise<number>;
  /** AG-071. One entry of one site, or `null` for anything else. */
  findWaitlistEntry(query: WaitlistEntryQuery): Promise<WaitlistEntryView | null>; // prettier-ignore
  /**
   * AG-064. Appends the attempt and applies the status the domain decided, in
   * ONE transaction.
   *
   * TOGETHER AND NOT IN TWO CALLS: an attempt written without the status that
   * follows from it leaves an entry that has used up its calls still competing
   * for slots (AG-066), and the trail is append-only, so the write cannot be
   * taken back.
   */
  recordWaitlistContact(attempt: NewContactAttempt): Promise<WaitlistEntryView>;
  /**
   * AG-063. Marks the entry `SCHEDULED` and links it to the appointment, in
   * one statement because they are one fact —
   * `waitlist_entry_conversion_complete` is a biconditional.
   *
   * The adapter translates what the database refuses: an appointment of
   * another chart, a conversion with no recorded acceptance (AG-064), an entry
   * already closed (AG-067), and a slot another entry already claimed.
   */
  convertWaitlistEntry(conversion: WaitlistConversion): Promise<WaitlistEntryView>; // prettier-ignore
}

/** Injection token. The application never names the adapter. */
export const WAITLIST_REPOSITORY = Symbol('WaitlistRepository');
