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
import type { NoShowCountRow } from './no-show-metric';
import type { PresenceEntry } from './overbooking-policy';
import type { SubjectStatusFact } from './subject-status';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  AgendaOccupancy,
  PractitionerAvailability,
  ScheduleRule,
} from './slot-availability';

import type {
  AgendaEntryKind,
  AgendaEntryStatus,
  PatientSubjectStatus,
} from './agenda-entry';

export type {
  AgendaEntryKind,
  AgendaEntryStatus,
  PatientSubjectStatus,
} from './agenda-entry';

// Re-exported for the same reason as the two above: it is part of THIS port's
// signature, so an adapter or a double should not have to know which domain
// file the booking window happens to live in.
export type { StoredSiteParameters } from './booking-policy';
export type { NoShowCountRow } from './no-show-metric';
export type { SubjectStatusFact } from './subject-status';

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
  /**
   * AG-035, AG-036. The constancy of an overbooking, `null` on every entry
   * that occupies the calendar — `agenda_entry_overbooking_coherence`
   * guarantees the pairing, so «`blocksCalendar` false with no reason» is not
   * a row this type has to describe.
   *
   * THE REASON IS SERVED, AND IT IS NOT THE OTHER ONE. `reason` — the motive
   * for the visit — is health data and never leaves this module (AG-072,
   * AG-074). This one is administrative: why the grid was broken. Two columns
   * is what lets AG-036 be answered without a condition in a serialiser.
   */
  overbookingReason: string | null;
  /** Who authorised it (AG-035). Deliberately not `createdById` — AG-103. */
  overbookingAuthorisedById: string | null;
  /** AG-018: set when the slot was given back. */
  releasedAt: Date | null;
  /**
   * AG-041, AG-118. The real instant of arrival, `null` until it happens.
   *
   * IT IS SERVED SO THE DELAY CAN BE COMPUTED AND NEVER STORED. AG-118 is the
   * difference between this and `startsAt`, and it exists as a derivation
   * precisely so nothing types it: a stored copy of a subtraction is a third
   * version of a fact that ages and then disagrees with the two columns it
   * came from.
   */
  checkedInAt: Date | null;
  /**
   * AG-121. Where the PATIENT is, on the axis the status does not carry, and
   * the instant of the last change.
   *
   * BOTH `null` OR NEITHER — `agenda_entry_subject_status_carries_its_instant`
   * guarantees the pairing, and it is what makes «tiempo en el estado actual»
   * (AG-135) calculable without joining anything. `null` on a block (a theatre
   * is not in pre-consultation) and on every appointment that has not arrived
   * yet (AG-127).
   */
  subjectStatus: PatientSubjectStatus | null;
  subjectStatusAt: Date | null;
  /**
   * AG-128, Ley 77 art. 10. That the emergency call WAS MADE at arrival, and
   * separately whether it came out positive.
   *
   * TWO FIELDS AND NOT ONE, because `emergencyFlaggedAt` alone cannot tell
   * «assessed, not an emergency» from «nobody assessed anybody», and proving
   * the second is what art. 10 obliges and art. 13 backs with prison.
   *
   * `emergencyNote` IS NOT HERE. It is free text somebody types about a
   * patient's condition, which is health data, and this view is read by anyone
   * holding `agenda:read` over the site with no row in `access_audit` — the
   * same reasoning that keeps `reason` out (AG-072, AG-074, SC-006).
   */
  emergencyAssessedAt: Date | null;
  emergencyFlaggedAt: Date | null;
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
  /**
   * AG-150. The state of the appointment's LIVE attention, or `null`.
   *
   * THE STATE AND NOT THE ATTENTION: whoever sees the agenda may hold no
   * `record:read`, and the identifier would be the key to a clinical record.
   * The state is what the menu needs —AG-045 refuses what a live attention
   * forbids— and what the board needs to say «Interrumpida» (D-076).
   */
  attention: AttentionStatus | null;
}

/**
 * AG-150. The states an attention can be in, as the agenda reads them. A
 * union of its own and not an import from `encounter`: no module imports
 * another, and the database enum is the shared contract.
 */
export type AttentionStatus =
  'OPEN' | 'ON_HOLD' | 'DISCONTINUED' | 'DISCHARGED' | 'COMPLETED';

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

/** AG-012, AG-028: whose rules, at which site, on which day they are read for. */
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
 * will turn up for it. Nor by the site (AG-144): they are the practitioner's
 * entries at EVERY site, because the `EXCLUDE` does not look at the site
 * either. Which of them may be shown is the domain's decision.
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
  /**
   * AG-035, AG-036, D-005. Present exactly when this is a deliberate
   * overbooking, and then the entry is written with `blocks_calendar = false`.
   *
   * ONE OPTIONAL OBJECT AND NOT THREE OPTIONAL FIELDS: the three travel
   * together or not at all — the base refuses any other combination — and a
   * shape that allowed «reason without authoriser» would be inviting the
   * adapter to write a row the CHECK then rejects with a constraint name.
   */
  overbooking?: OverbookingRecord;
}

/** AG-035, AG-036: what makes an overbooking an exception ON the record. */
export interface OverbookingRecord {
  /** Already trimmed and known non-empty (`requireOverbookingReason`). */
  reason: string;
  /** The account that authorised it, never the one that booked it (AG-103). */
  authorisedById: string;
}

/**
 * AG-037, AG-038: a block of agenda — leave, theatre, a meeting.
 *
 * NO PATIENT AND NO BOOKING CHANNEL, and neither is an omission: a block has
 * no patient (`agenda_entry_patient_coherence`, AG-021) and nobody books it by
 * telephone (`agenda_entry_booking_channel_coherence`, AG-034). It shares
 * everything else with an appointment — including the three `EXCLUDE`
 * constraints, which is AG-037 in one line.
 */
export interface NewBlock {
  siteId: string;
  practitionerId: string;
  roomId?: string;
  startsAt: Date;
  endsAt: Date;
  /** Why the agenda is closed. Administrative, and served in the listing. */
  reason: string;
  createdById: string;
}

/** AG-100: the overbookings of one practitioner within one clinical day. */
export interface OverbookingCountQuery {
  siteId: string;
  practitionerId: string;
  /**
   * The day as INSTANTS, resolved in `America/Guayaquil` by the service
   * (AG-001), exactly like the daily agenda. A `::date` cast in SQL would use
   * the session's zone and an overbooking at 19:30 would count against the
   * following day — at which point the cap stops limiting the evenings, which
   * is when it gets abused.
   */
  from: Date;
  untilExclusive: Date;
}

/** AG-101: whose permissions are being asked about, and where. */
export interface AuthoriserPermissionsQuery {
  userId: string;
  siteId: string;
}

/**
 * AG-038: an appointment that stands in the way of a block.
 *
 * THREE FIELDS AND NO MORE. The identifier and the hours are what the refusal
 * may say (AG-072, AG-074, SC-006); the name AG-109 grants to the day's
 * listing has no business in an error that reaches logs.
 */
export interface BlockingAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/** AG-038: which interval is about to be blocked, and for whom. */
export interface BlockingAppointmentsQuery {
  siteId: string;
  practitionerId: string;
  startsAt: Date;
  endsAt: Date;
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
  /**
   * AG-045: whether a LIVE encounter (not `ENTERED_IN_ERROR`) hangs off this
   * entry. An annulled one does not count (EN-168).
   */
  hasEncounter: boolean;
  /**
   * AG-148: whether that live encounter has any clinical note. The note is
   * the boundary of D-076: without it there was no consultation.
   */
  encounterHasNote: boolean;
}

/**
 * AG-148. The live attention to interrupt in the same transaction, with origin
 * `PATIENT` and the author of the transition: the patient left before the
 * doctor opened the note.
 */
export interface AttentionInterruption {
  reason: string;
  at: Date;
}

/**
 * The columns a transition stamps. Shared with the pure status machine.
 *
 * AN INTERFACE AND NO LONGER A `Record` OF DATES, since the arrival stopped
 * being only an instant: AG-127 moves the subject status on the same write,
 * and AG-128 records the article-10 assessment on it. Every key is a column of
 * `agenda_entry`, spread straight into the update — a name that is not one
 * would not compile in the adapter, which is what keeps this honest.
 */
export interface TransitionEffects {
  /** AG-041. The real instant of arrival. */
  checkedInAt?: Date;
  /** AG-042. */
  noShowAt?: Date;
  /** AG-044. */
  cancelledAt?: Date;
  /** AG-042, AG-044, AG-116, AG-117: what «liberar el cupo» means. */
  releasedAt?: Date;
  /**
   * AG-116. The instant somebody gave up waiting, in its own column.
   *
   * Not the history row: AG-140 filters outcomes by date over `agenda_entry`,
   * and forcing this one outcome to join against the trail would make the
   * metric a different query from its three neighbours for an asymmetry that
   * answers nothing.
   */
  leftWithoutBeingSeenAt?: Date;
  /** AG-116. Optional: asking a receptionist WHY somebody got tired of
   * waiting produces a blank field or a guess. */
  leftWithoutBeingSeenReason?: string;
  /** AG-117. Its own instant, and its own reason. */
  enteredInErrorAt?: Date;
  /**
   * AG-117. ⚠️ NOT `cancellationNote`. One column for both acts would make it
   * unprovable from the row which of the two happened, which is exactly what
   * this status came to separate.
   */
  enteredInErrorReason?: string;
  /**
   * AG-127. The patient axis, moved by the appointment axis exactly twice:
   * `ARRIVED` on check-in and `DEPARTED` on `LEFT_WITHOUT_BEING_SEEN`. Every
   * other value is derived from a documented fact and never from here
   * (AG-122).
   */
  subjectStatus?: PatientSubjectStatus;
  /**
   * AG-121. Its instant. The database refuses one without the other
   * (`agenda_entry_subject_status_carries_its_instant`), so the two are always
   * written together.
   */
  subjectStatusAt?: Date;
  /**
   * AG-128, Ley 77 art. 10. THE ASSESSMENT ITSELF — who made the call and
   * when — recorded on every arrival whatever the answer was.
   */
  emergencyAssessedAt?: Date;
  emergencyAssessedById?: string;
  /**
   * AG-128. THE POSITIVE OUTCOME, and a different pair of columns on purpose:
   * with only these, `NULL` cannot tell «se calificó y no era una emergencia»
   * from «nadie calificó nada», and the second is what art. 13 turns into a
   * prison sentence.
   */
  emergencyFlaggedAt?: Date;
  emergencyFlaggedById?: string;
  emergencyNote?: string;
  /**
   * AG-131, Ley 77 art. 9. Why the coverage check was not done. Its presence
   * is what tells a datum that is MISSING from one the clinic decided not to
   * demand — and demanding it would be illegal in the case that matters most.
   */
  coverageCheckSkippedReason?: string;
}

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
  /** AG-148. Present only when the move interrupts the live attention. */
  interruptAttention?: AttentionInterruption;
}

/**
 * AG-122, AG-126. One derived movement of the patient axis.
 *
 * `fact` AND NOT `subjectStatus`: see `recordSubjectStatus`. `changedById` is
 * the author of the fact, taken from the session and never from a body, like
 * every other author in this module (AG-004).
 */
export interface SubjectStatusCommand {
  siteId: string;
  entryId: string;
  changedById: string;
  fact: SubjectStatusFact;
  /** The instant the fact was recorded, taken ONCE by the caller. */
  at: Date;
}

/**
 * AG-125, AG-127. What the patient-axis policy needs of the row, read INSIDE
 * the adapter's transaction — the same shape and the same reason as
 * `TransitionRead`: a decision taken on a read from a moment earlier is a
 * decision two callers can both take.
 */
export interface SubjectStatusRead {
  id: string;
  kind: AgendaEntryKind;
  status: AgendaEntryStatus;
  /** `null` until the appointment reaches `CHECKED_IN` (AG-127). */
  subjectStatus: PatientSubjectStatus | null;
}

/** AG-151. The interval an overbooking is asked for, and for whom. */
export interface PresenceQuery {
  practitionerId: string;
  siteId: string;
  startsAt: Date;
  endsAt: Date;
  /** The Ecuadorian date of `startsAt`, which decides the rules in force. */
  date: ClinicalDate;
}

/** AG-004: who asks for which entry. The author comes from the session. */
export interface TransitionCommand {
  siteId: string;
  entryId: string;
  changedById: string;
}

/**
 * AG-050, AG-115. Everything the new appointment is allowed to decide.
 *
 * WHY THERE IS NO PATIENT, ROOM OR REASON HERE, and it is the load-bearing
 * half. Those three are copied from the stored row INSIDE the transaction by
 * the adapter, and no caller can name them: a body that could change the
 * patient would let «reprogramar» hand one person's hour to another with one
 * field, and `reason` is the free text where the motive for the visit lands,
 * which this module never reads back (AG-072, AG-074).
 *
 * WHY THE PRACTITIONER AND THE TYPE *ARE* HERE (AG-115). They are columns of a
 * row that is being BORN — AG-050 already creates one — so choosing them is
 * not a mutation of the appointment that exists. Forbidding it would not stop
 * receptionists who picked the wrong doctor; it would only make them annul and
 * book again, losing the link AG-051 builds and reporting an annulment to
 * AG-080 that never was one. They are RESOLVED BY THE SERVICE, never optional
 * here: the adapter must not have to decide what «absent» means.
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
  /** AG-115. The one who will attend: asked for, or the original's. */
  practitionerId: string;
  /** AG-115, SP-028. The type of attention, or `null` when there is none. */
  serviceTypeId: string | null;
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
 * AG-111, SP-005, SP-008. One specialty a practitioner actually holds.
 *
 * The identifier is what the SERVICE TYPES hang off (AG-112), and `isPrimary`
 * is what lets the booking dialog arrive with a choice already made instead of
 * asking a question whose answer is already stored.
 */
export interface AgendaSpecialty {
  id: string;
  name: string;
  isPrimary: boolean;
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
  /** AG-111. The active ones only, primary first. */
  specialties: readonly AgendaSpecialty[];
}

/**
 * AG-112. An attention type as the BOOKING screen needs it.
 *
 * Three fields and no `active`: only the active ones are ever listed here, so
 * a flag that is always `true` would only invite a client to filter on it.
 * `specialtyId` is absent for the same reason — the caller named it in the URL.
 */
export interface AgendaServiceType {
  id: string;
  name: string;
  /** SP-020. The catalogue's base duration, for the option's label. */
  durationMinutes: number;
}

/**
 * The caller's site scope, as `Principal.sitesFor` states it: every site, or
 * an explicit list. Declared here so the port does not import authorisation
 * machinery — the DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/**
 * AG-080, AG-081: which appointments the inasistencia cube is counted over.
 *
 * THE WINDOW ARRIVES AS INSTANTS, resolved in Ecuador by `noShowWindow`, for
 * the same reason the daily agenda's does (AG-001): a `::date` cast in SQL
 * would use the session's zone, and an appointment at 19:30 would be counted
 * against the following day — which is precisely the evening franja the metric
 * exists to watch.
 *
 * NO STATUS FILTER HERE, and that is deliberate. AG-081 decides which statuses
 * count, and it decides it in `summariseNoShow`, where a test names it. An
 * adapter that filtered would be a second copy of the rule that no test could
 * break.
 */
export interface NoShowCountsQuery {
  /** The caller's own resolved scope: the route declares `'query'`. */
  sites: SiteScopeFilter;
  from: Date;
  untilExclusive: Date;
}

/**
 * What the agenda needs from storage, stated without naming a database.
 *
 * `AgendaService` only ever sees this port, so the booking rules run against
 * in-memory doubles; what must hold under concurrency — the overlaps, the
 * transitions — is written and arbitrated inside the adapter, and proved
 * against a real PostgreSQL.
 */
export interface AgendaRepository {
  /** AG-107. Sites in the caller's scope, by name, for the site selector. */
  listSites(scope: SiteScopeFilter): Promise<AgendaSite[]>;
  /** AG-108, AG-111. Active, schedulable practitioners attached to the site. */
  listSchedulablePractitioners(
    siteId: string,
  ): Promise<SchedulablePractitioner[]>;
  /** AG-112. The active attention types of one specialty, with their base duration. */
  listServiceTypes(specialtyId: string): Promise<AgendaServiceType[]>;
  /**
   * AG-080. Appointments of the window, counted by site, practitioner, channel
   * and status — the cube `summariseNoShow` reduces.
   *
   * APPOINTMENTS ONLY. A block has no patient and no channel
   * (`agenda_entry_patient_coherence`, `agenda_entry_booking_channel_coherence`)
   * so it cannot be attended or missed, and it has no cell to land in. That is
   * a fact about the ROW's shape, not a policy about what counts — which is
   * why it is the one filter this method is allowed to hold.
   */
  noShowCounts(query: NoShowCountsQuery): Promise<readonly NoShowCountRow[]>;
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
   * AG-037. Writes a block and lets the same three `EXCLUDE` constraints
   * arbitrate it, because their predicate never mentioned `kind`.
   *
   * IT IS A SECOND METHOD AND NOT A FLAG ON `book`, because what it writes is
   * a different row: no patient, no channel, no service type, and a status
   * (`BLOCKED`) that AG-046 reserves for blocks. A boolean on `NewBooking`
   * would have made four of its fields conditionally meaningless.
   */
  blockAgenda(block: NewBlock): Promise<AgendaEntryView>;
  /**
   * AG-100. How many overbookings this practitioner already holds at this site
   * within the day, counted over the instants the service resolved.
   *
   * IT COUNTS WHAT OCCUPIES NOTHING. `blocks_calendar = false` and not
   * released: a released overbooking gave its exception back, and counting it
   * would spend a cap on an appointment nobody is going to attend.
   */
  overbookingCount(query: OverbookingCountQuery): Promise<number>;
  /**
   * AG-151. Where the practitioner is during the interval: their entries still
   * in force that touch it, AT ANY SITE (blocks, appointments, overbookings),
   * and their schedule rules in force that day AT OTHER SITES. The policy
   * (`checkPractitionerIsThere`) decides what each means.
   */
  presenceOf(query: PresenceQuery): Promise<{
    entries: PresenceEntry[];
    rulesElsewhere: ScheduleRule[];
  }>;
  /**
   * AG-101. The permission codes the NAMED AUTHORISER holds over this site.
   *
   * EMPTY FOR AN ACCOUNT THAT DOES NOT EXIST, is inactive, or holds nothing
   * here — the three answer the same on purpose: the refusal must not become a
   * way of confirming which accounts exist (`AGENDA_ENTRY_NOT_FOUND` and
   * `ROOM_NOT_IN_SITE` take the same line).
   *
   * STRINGS AND NOT `Permission`: they are rows. Whether the code declares
   * them is a different question from whether this person holds them, and this
   * port answers the second.
   */
  authoriserPermissions(
    query: AuthoriserPermissionsQuery,
  ): Promise<readonly string[]>;
  /**
   * AG-038. The appointments that occupy the calendar inside an interval about
   * to be blocked, ordered by start.
   *
   * A READ BEFORE THE WRITE, AND THE `EXCLUDE` IS STILL THE GUARANTEE
   * (AG-037). This list can go stale between the read and the insert; what it
   * buys is the ENUMERATION the requirement asks for, which a constraint
   * rejection cannot give — PostgreSQL names one conflicting row at most, and
   * a block over a morning usually crosses several.
   */
  blockingAppointments(
    query: BlockingAppointmentsQuery,
  ): Promise<readonly BlockingAppointment[]>;
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
  /**
   * AG-122 to AG-127. Moves the PATIENT axis from a documented fact.
   *
   * THE PORT IS DECLARED AND NO ROUTE REACHES IT, and that is the requirement
   * rather than an unfinished edge. AG-122 forbids exposing any route that
   * sets `IN_PREPARATION`, `READY`, `RECEIVING_CARE`, `ON_LEAVE` or
   * `DEPARTED`: five of the six are consequences of work that gets documented
   * elsewhere — vitals opened and saved, the clinical note opened, the order
   * that sends the patient out, the account settled — and the sixth,
   * `ARRIVED`, is written by the check-in effect because the fact it stands
   * for leaves no other trace. The callers are the facts of `encounter`, and
   * `encounter` has no code yet: AG-121 to AG-127 depend on it and not the
   * other way round.
   *
   * THE FACT IS THE ARGUMENT, NOT THE STATE. A signature that took a
   * `PatientSubjectStatus` would be the forbidden box wearing a different
   * name; what a caller may say is which fact occurred, and what the board
   * shows for it is `subjectStatusOf`'s decision.
   *
   * THE TRAIL OF AG-126 IS NOT COMPLETE AND THIS IS WHERE IT SHOWS. The two
   * columns hold the CURRENT state and its instant — a cache of the last row,
   * which is what makes AG-135 computable without a join — but at the third
   * change nothing can answer when the first two happened or who caused them.
   * `agenda_subject_status_history` is the «Falta esquema» of AG-126 and
   * belongs to the same delivery as the encounter facts that will call this.
   */
  recordSubjectStatus(
    command: SubjectStatusCommand,
    decide: (entry: SubjectStatusRead) => PatientSubjectStatus,
  ): Promise<AgendaEntryView>;
}

/** Injection token. The application never names the adapter. */
export const AGENDA_REPOSITORY = Symbol('AgendaRepository');
