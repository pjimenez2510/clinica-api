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

import type { BookingChannel } from './booking-policy';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  AgendaOccupancy,
  PractitionerAvailability,
  ScheduleRule,
} from './slot-availability';

export type AgendaEntryKind = 'APPOINTMENT' | 'BLOCK';

export type AgendaEntryStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'BLOCKED';

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
  startsAt: Date;
  endsAt: Date;
  status: AgendaEntryStatus;
  /** `false` marks a deliberate overbooking (AG-036). */
  blocksCalendar: boolean;
  /** AG-018: set when the slot was given back. */
  releasedAt: Date | null;
  bookingChannel: BookingChannel | null;
  serviceTypeConceptId: string | null;
  /**
   * NO `reason` HERE EITHER, deliberately. The reason for the visit is stored
   * (`NewBooking` carries it) and is never read back by this module: a listing
   * that returned it would hand health data to everyone with `agenda:read`
   * over the site, forty rows at a time and with nothing in `access_audit`
   * (AG-072, AG-074, SC-006). The chart is opened through the patient
   * register, and that request is the one that leaves a record.
   */
  createdById: string | null;
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
  serviceTypeConceptId?: string;
  reason?: string;
  /** AG-029: who booked it. */
  createdById: string;
}

export interface AgendaRepository {
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
   * AG-003, AG-010, AG-011, AG-013, AG-014: the same over a range of dates,
   * plus the entries that occupy the calendar in it.
   *
   * It READS ONLY. There is no companion method that stores a slot, because a
   * free slot is a derivation and never a row (AG-003).
   */
  availabilityContextFor(
    query: AvailabilityContextQuery,
  ): Promise<AvailabilityContext>;
  /**
   * AG-020, AG-023 to AG-026, AG-030.
   *
   * Writes and lets the database arbitrate. The adapter retries a
   * serialisation failure and translates a constraint rejection; it never
   * checks first.
   */
  book(booking: NewBooking): Promise<AgendaEntryView>;
}

/** Injection token. The application never names the adapter. */
export const AGENDA_REPOSITORY = Symbol('AgendaRepository');
