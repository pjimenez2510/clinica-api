/**
 * What the agenda needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements
 * it. `dependency-cruiser` enforces the direction.
 *
 * WHY THERE IS A PATIENT QUERY HERE. AG-027 has to refuse a booking for a
 * chart that was merged into another, and that means reading the patient. It
 * is NOT done by importing `modules/patients`: no module imports another, and
 * the day that rule is bent for "just one lookup" the modules stop being
 * modules. The agenda declares the two fields it needs and its own adapter
 * answers them.
 *
 * WHAT IS DELIBERATELY ABSENT: anything that asks whether a slot is free. The
 * three `EXCLUDE USING gist` constraints arbitrate that, and a "is it taken?"
 * method would be an invitation to check first and insert afterwards — which
 * is precisely the race those constraints exist to close.
 */

import type { BookingChannel, StoredSiteParameters } from './booking-policy';
import type { Holiday } from './holiday-calendar';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  AgendaOccupancy,
  PractitionerAvailability,
  ScheduleRule,
} from './slot-availability';

import type { AgendaEntryKind, AgendaEntryStatus } from './agenda-entry';

export type { AgendaEntryKind, AgendaEntryStatus } from './agenda-entry';

// Re-exported for the same reason as the two above: it is part of THIS port's
// signature, so an adapter or a double should not have to know which domain
// file the booking window happens to live in.
export type { StoredSiteParameters } from './booking-policy';

/**
 * An agenda entry as the day's list shows it.
 *
 * NO PATIENT NAME AND NO CLINICAL CONTENT: the identifier only. The screen
 * that needs the name asks the patient register for it, and that request is
 * the one that leaves an audit entry (AG-073). Joining the name in here would
 * make every listing an undocumented read of forty charts (AG-072, SC-004).
 */
export interface AgendaEntryView {
  id: string;
  kind: AgendaEntryKind;
  siteId: string;
  practitionerId: string;
  roomId: string | null;
  /** `null` exactly when `kind` is `BLOCK` (AG-021). */
  patientId: string | null;
  /**
   * Identification for the calendar card, in filing order («Andrade, Rosa»).
   * The REASON never rides here — identification is operational, the motive
   * is clinical (AG-072/074). Null on blocks.
   */
  patientName: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AgendaEntryStatus;
  /** `false` marks a deliberate overbooking (AG-036). */
  blocksCalendar: boolean;
  /** AG-018: set when the slot was given back. */
  releasedAt: Date | null;
  bookingChannel: BookingChannel | null;
  /**
   * SP-028: the service type recepción chose, `service_type.id`.
   *
   * It is the clinic's OWN master data (SP-020) and not a clinical concept of
   * the MSP catalogue, which is what this column used to point at. Until C4 it
   * could not be «el tipo registrado en la cita» that SP-028 asks for, and the
   * database had nothing to refuse a delete over (SP-025).
   */
  serviceTypeId: string | null;
  /**
   * NO `reason` HERE EITHER, deliberately. The reason for the visit is stored
   * (`NewBooking` carries it) and is never read back by this module: a listing
   * that returned it would hand health data to everyone with `agenda:read`
   * over the site, forty rows at a time and with nothing in `access_audit`
   * (AG-072, AG-074, SC-006). The chart is opened through the patient
   * register, and that request is the one that leaves a record.
   */
  createdById: string | null;
  /**
   * AG-051. The entry this one came from when it was rescheduled, and the one
   * that replaced it. Both `null` on an appointment that was booked directly
   * and never moved.
   *
   * TWO FIELDS OVER ONE COLUMN, and that is the point of the shape: the
   * database stores `rescheduled_from_id` alone, and the forward direction is
   * the partial unique index over it. A client reading either entry sees the
   * other without a second call, which is what «la referencia a la otra» has
   * to mean for it to be worth anything.
   */
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
}

/**
 * The day, already resolved to instants.
 *
 * The bounds arrive as instants and not as a date ON PURPOSE: turning
 * "14 September" into `[05:00Z, 05:00Z)` is the Ecuadorian-calendar rule of
 * AG-001, it is pure, and it is tested without a database. Handing the adapter
 * a date string would push that decision into SQL, where the session's time
 * zone decides it instead.
 */
export interface DailyAgendaQuery {
  siteId: string;
  from: Date;
  untilExclusive: Date;
  practitionerId?: string;
  roomId?: string;
  /** AG-018. `false` is what the partial index `… WHERE released_at IS NULL` serves. */
  includeReleased: boolean;
}

/** AG-027. The two fields the agenda needs about a patient, and no more. */
export interface PatientBookingStatus {
  id: string;
  /** The MRN of the surviving chart, or `null` when this one is current. */
  mergedIntoMrn: string | null;
}

export interface ScheduleContextQuery {
  practitionerId: string;
  siteId: string;
  /** The Ecuadorian date the weekly rules are read for. */
  date: ClinicalDate;
}

/** What the booking policy needs in order to judge an interval. */
export interface ScheduleContext {
  /** `null` when the practitioner does not exist or works at no site. */
  practitioner: PractitionerAvailability | null;
  rules: readonly ScheduleRule[];
}

/**
 * AG-003, AG-010: what deriving availability over a range needs.
 *
 * TWO WINDOWS FOR ONE RANGE, and they are not redundant. `validFrom`/`validTo`
 * of a schedule rule are `date` columns — Ecuadorian calendar dates, no zone
 * involved — so the rules are narrowed by dates. `agenda_entry.starts_at` is a
 * `timestamptz`, so the occupancy is narrowed by instants, and those instants
 * are resolved HERE in Ecuador (AG-001) rather than by a `::date` cast in SQL
 * that would use the session's zone. Handing the adapter one of the two and
 * letting it derive the other is how the two halves end up disagreeing at
 * 20:30.
 */
export interface AvailabilityContextQuery {
  practitionerId: string;
  siteId: string;
  /** Inclusive clinical dates the weekly rules are read for. */
  fromDate: ClinicalDate;
  toDate: ClinicalDate;
  /** The same range as instants: `[from, untilExclusive)` in Ecuador. */
  from: Date;
  untilExclusive: Date;
}

/**
 * The rules in force plus what already occupies the calendar.
 *
 * The entries are NOT filtered by the rules (AG-011): an appointment booked
 * under a rule that has since expired is still an appointment, and the person
 * will turn up for it.
 */
export interface AvailabilityContext extends ScheduleContext {
  entries: readonly AgendaOccupancy[];
  /**
   * AG-015, AG-016, AG-092: the holidays of the range this site could
   * observe — its own and the national ones — each carrying the sites that
   * work it. WHICH of them close the site is decided by the domain
   * (`holiday-calendar.ts`), not by the `WHERE` clause that read them: a
   * filter that resolved the scope in SQL would be a second copy of AG-091
   * with no test naming it.
   */
  holidays: readonly Holiday[];
  /**
   * AG-093: the calendar years the holiday catalogue has any row for.
   *
   * IT IS NOT DERIVABLE FROM `holidays`, which is why it is a field of its
   * own. A range asked over the first week of January returns no holiday
   * whether the year was loaded and has none that week, or was never loaded
   * at all — and the requirement forbids answering those two the same way.
   */
  calendarYears: readonly number[];
}

/**
 * AG-110: one site, one clinical date, so the booking path can ask the same
 * calendar the availability query asks.
 *
 * A DATE AND NOT A RANGE, because a booking happens on one day; and the date
 * is the ECUADORIAN one of the instant that was stored, resolved by the
 * service (AG-001) rather than by a `::date` cast in SQL that would use the
 * session's zone and warn about the wrong day for an evening appointment.
 */
export interface HolidayQuery {
  siteId: string;
  date: ClinicalDate;
}

/** AG-020 and AG-029: what a booking is made of. Nothing is optional by accident. */
export interface NewBooking {
  siteId: string;
  practitionerId: string;
  patientId: string;
  roomId?: string;
  startsAt: Date;
  endsAt: Date;
  /** AG-029. Validated by the domain before it gets here. */
  bookingChannel: BookingChannel;
  /** SP-028: `service_type.id`. The FK refuses one that does not exist. */
  serviceTypeId?: string;
  reason?: string;
  /** AG-029: who booked it. */
  createdById: string;
}

/**
 * What the transition policy needs to know about the entry, read INSIDE the
 * adapter's transaction. No patient, no reason: the machine judges states
 * and instants, never people.
 */
export interface TransitionRead {
  id: string;
  kind: AgendaEntryKind;
  status: AgendaEntryStatus;
  startsAt: Date;
  releasedAt: Date | null;
  /** AG-045: whether an encounter already hangs off this entry. */
  hasEncounter: boolean;
}

/** The columns a transition stamps. Shared with the pure status machine. */
export type TransitionEffects = Partial<
  Record<'checkedInAt' | 'noShowAt' | 'cancelledAt' | 'releasedAt', Date>
>;

/**
 * What the policy decided: the new status, its stamps, and the two notes.
 *
 * `cancellationNote` lands on the entry ONLY when the policy set it (the
 * service does so exactly on CANCELLED, AG-044); `historyNote` is the free
 * text of the history row (AG-004), carried when the caller gave a reason.
 */
export interface StatusChange {
  to: AgendaEntryStatus;
  effects: TransitionEffects;
  cancellationNote?: string;
  historyNote?: string;
}

/** AG-004: who asks for which entry. The author comes from the session. */
export interface TransitionCommand {
  siteId: string;
  entryId: string;
  changedById: string;
}

/**
 * AG-050. The ONLY thing a reschedule decides about the new appointment.
 *
 * WHY THERE IS NO PATIENT, PRACTITIONER, ROOM OR TYPE HERE. The new entry is
 * the old one moved: everything except the interval and the channel is copied
 * from the stored row, INSIDE the transaction, by the adapter. Passing them
 * from above would mean the caller could quietly reschedule an appointment
 * onto a different patient — and it would also mean loading `reason`, which is
 * the free text where the motive for the visit lands and which this module
 * never reads back (AG-072, AG-074).
 *
 * THE CHANNEL IS ASKED FOR AND NOT COPIED, on purpose: AG-080 reports
 * inasistencia BY CHANNEL, and the reschedule was requested however it was
 * requested — inheriting «WEB» for a call that came in by telephone would
 * report a lie about a booking that did happen.
 */
export interface RescheduledBooking {
  startsAt: Date;
  endsAt: Date;
  /** AG-029, AG-034. Validated by the domain before it gets here. */
  bookingChannel: BookingChannel;
}

/**
 * AG-050, AG-051. What one reschedule leaves behind: two entries that name
 * each other.
 *
 * BOTH TRAVEL BACK, and it is not convenience. The screen that asked has to
 * repaint the annulled row and the new one, and a caller that only got the new
 * one would have to re-read the day to find out what happened to the old — a
 * second question whose answer could already have changed.
 */
export interface RescheduleOutcome {
  original: AgendaEntryView;
  created: AgendaEntryView;
}

/** One entry, by id and site. `null` covers both «no existe» and «es de otra sede». */
export interface EntryQuery {
  siteId: string;
  entryId: string;
}

/**
 * SP-023, rungs one and two: what STORAGE knows about how long this
 * practitioner's appointment of this type lasts.
 *
 * WHY THE AGENDA ASKS FOR IT INSTEAD OF CALLING `specialties` OR `staff`. The
 * hierarchy is SP-023 and the tables belong to two other modules, and no module
 * imports another — `pnpm arch:check` refuses it. Same route the holidays took
 * in E7 (AG-090): the agenda declares the fields it needs, its own adapter
 * answers them, and the ORDER of the rungs stays in ONE pure function
 * (`resolveDuration` in `shared/domain`) that every caller shares. A second
 * copy of the hierarchy is what makes the duration recepción is shown and the
 * duration that gets booked drift apart.
 *
 * THE THIRD RUNG IS NOT HERE. `ruleSlotMinutes` comes from the schedule rule
 * the agenda already resolved (AG-106), which is a decision this port cannot
 * take: which rule governs an instant is domain policy, not a row.
 */
export interface StoredDurationSources {
  /** SP-022, the top rung: this practitioner's own minutes, or `null`. */
  exceptionMinutes: number | null;
  /** SP-020, the middle rung: the base duration of the specialty·type. */
  serviceTypeMinutes: number;
}

/** SP-023. One practitioner, one service type. */
export interface DurationSourcesQuery {
  practitionerId: string;
  serviceTypeId: string;
}

/** AG-107. A site the caller may schedule in: identifier and name, nothing else. */
export interface AgendaSite {
  id: string;
  name: string;
}

/**
 * AG-108. A practitioner a receptionist can pick in the booking screen.
 *
 * Name only, ON PURPOSE: the cedula and the ACESS registration travel in
 * signed documents (REQ-050), not in a dropdown that anyone holding
 * `agenda:read` can open.
 */
export interface SchedulablePractitioner {
  id: string;
  /** Account id, so the interface can preselect the signed-in doctor's own column. */
  userId: string;
  fullName: string;
}

/**
 * The caller's site scope, as `Principal.sitesFor` states it: every site, or
 * an explicit list. Declared here so the port does not import authorisation
 * machinery — the DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];

export interface AgendaRepository {
  /** AG-107. Sites in the caller's scope, by name, for the site selector. */
  listSites(scope: SiteScopeFilter): Promise<AgendaSite[]>;
  /** AG-108. Active, schedulable practitioners attached to the site. */
  listSchedulablePractitioners(
    siteId: string,
  ): Promise<SchedulablePractitioner[]>;
  /** AG-017, AG-018. Ordered by start instant. */
  dailyAgenda(query: DailyAgendaQuery): Promise<AgendaEntryView[]>;
  /** AG-027. `null` when no such chart exists — the insert then fails on the FK. */
  findPatientForBooking(
    patientId: string,
  ): Promise<PatientBookingStatus | null>;
  /**
   * AG-071: the site a consulting room belongs to, or `null` when there is no
   * such room — the insert then fails on the foreign key, exactly like an
   * unknown patient.
   */
  roomSiteOf(roomId: string): Promise<string | null>;
  /** AG-012, AG-028, AG-104: the rules in force and whether the practitioner takes appointments. */
  scheduleContextFor(query: ScheduleContextQuery): Promise<ScheduleContext>;
  /**
   * SP-023, SP-028: the two stored rungs of the duration hierarchy.
   *
   * `null` when no such service type exists — the service turns that into
   * `SERVICE_TYPE_NOT_FOUND`, because a proposal is a READ and a wrong id
   * there is a missing resource, not a booking that a foreign key can refuse.
   */
  durationSourcesFor(
    query: DurationSourcesQuery,
  ): Promise<StoredDurationSources | null>;
  /**
   * AG-094, AG-095: the operating parameters of the site, or `null` when it
   * has no row at all — the domain then falls back to the code defaults.
   *
   * IT RETURNS WHAT IS STORED AND RESOLVES NOTHING. Filling the gaps is
   * `resolveBookingParameters` in the domain, where the chain of AG-095 is
   * written once and tested without a database; an adapter that defaulted on
   * the way out would be a second, silent copy of the same rule, and the
   * fallback would stop being visible to the test that names the requirement.
   */
  siteParametersFor(siteId: string): Promise<StoredSiteParameters | null>;
  /**
   * AG-003, AG-010, AG-011, AG-013, AG-014: the same over a range of dates,
   * plus the entries that occupy the calendar in it and the holidays the site
   * could observe (AG-015, AG-016, AG-090, AG-093).
   *
   * It READS ONLY. There is no companion method that stores a slot, because a
   * free slot is a derivation and never a row (AG-003).
   */
  availabilityContextFor(
    query: AvailabilityContextQuery,
  ): Promise<AvailabilityContext>;
  /**
   * AG-110: the holidays of ONE date this site could observe, each carrying
   * its AG-092 exceptions — the same rows `availabilityContextFor` hands over
   * for a range, asked for the day a booking landed on.
   *
   * WHICH of them closes the site is still the domain's decision
   * (`holiday-calendar.ts`), for the same reason as there: resolving the scope
   * in the `WHERE` clause would be a second copy of AG-091 with no test
   * naming it.
   */
  holidaysFor(query: HolidayQuery): Promise<readonly Holiday[]>;
  /**
   * AG-020, AG-023 to AG-026, AG-030.
   *
   * Writes and lets the database arbitrate. The adapter retries a
   * serialisation failure and translates a constraint rejection; it never
   * checks first.
   */
  book(booking: NewBooking): Promise<AgendaEntryView>;
  /**
   * AG-004, AG-040 to AG-045: one status transition, atomically.
   *
   * THE POLICY TRAVELS AS A FUNCTION, and that is the design. The service
   * owns the rules (the table, AG-043, AG-045) but they must judge the row
   * AS IT IS INSIDE THE TRANSACTION, not a read from a moment earlier — so
   * the adapter reads, hands the row to `decide`, and applies whatever it
   * returns in the same transaction, together with the history row (AG-004).
   *
   * The race two receptionists can still run — both read the same status,
   * both decide — is closed by the adapter with a CONDITIONAL update on the
   * status it read: the loser matches zero rows and is refused with the
   * winner's status, never with a stale one.
   *
   * `decide` throws a domain error to refuse; the adapter aborts and nothing
   * is written. It never lands on a missing entry: the adapter refuses an
   * unknown or foreign-site identifier first.
   */
  transition(
    command: TransitionCommand,
    decide: (entry: TransitionRead) => StatusChange,
  ): Promise<AgendaEntryView>;
  /**
   * One entry of one site, or `null`. AG-071: an entry of another site answers
   * exactly like a missing one, so the caller cannot tell them apart.
   *
   * WHAT IT IS FOR: rescheduling has to judge the NEW interval against the
   * schedule of the practitioner who holds the appointment and against the
   * merge state of its patient, and neither is in the request — they are on
   * the row. It is a read BEFORE the transaction and it does not need to be
   * inside one: neither `patient_id` nor `practitioner_id` is written by any
   * path of this system, and everything that CAN change under us — the status,
   * the release, an encounter — is re-arbitrated by `reschedule` itself.
   */
  findEntry(query: EntryQuery): Promise<AgendaEntryView | null>;
  /**
   * AG-050, AG-051, AG-052: rescheduling, as ONE transaction.
   *
   * AG-052 IS WHY THIS IS A SINGLE PORT METHOD. «Liberar el cupo original» and
   * «crear una entrada nueva» could be `transition` followed by `book`, and
   * that composition is exactly what the requirement forbids: the day the
   * second call is refused — the destination slot is taken, the patient is
   * already booked there, the site's booking window says no — the first has
   * already committed and the patient is left with NO appointment at all. So
   * the two happen in one transaction or neither happens, and no caller can
   * assemble a version of this that does not.
   *
   * `decide` is `planReschedule`, handed down so the rules judge the row as it
   * is INSIDE the transaction (the same shape `transition` uses, for the same
   * reason). It throws to refuse, the transaction aborts, and the original is
   * still occupying the calendar.
   */
  reschedule(
    command: TransitionCommand,
    booking: RescheduledBooking,
    decide: (entry: TransitionRead) => StatusChange,
  ): Promise<RescheduleOutcome>;
}

/** Injection token. The application never names the adapter. */
export const AGENDA_REPOSITORY = Symbol('AgendaRepository');
