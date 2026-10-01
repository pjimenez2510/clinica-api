import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  AGENDA_REPOSITORY,
  type AgendaEntryStatus,
  type AgendaEntryView,
  type AgendaRepository,
  type OverbookingRecord,
  type SiteScopeFilter,
} from '../domain/agenda.repository';
import {
  AgendaEntryNotFoundError,
  BlockOverlapsAppointmentsError,
  CancellationReasonRequiredError,
  EmergencyAssessmentRequiredError,
  EnteredInErrorReasonRequiredError,
  InvalidAgendaTransitionError,
} from '../domain/agenda.errors';
import { checkBookingChannel, checkBookingFitsSchedule, checkBookingWindow, checkRoomBelongsToSite, resolveBookingParameters, ruleGoverningStart, type BookingChannel, type SiteBookingParameters } from '../domain/booking-policy'; // prettier-ignore
import {
  assertOverbookingAdmitted,
  checkOverbookingAuthoriser,
  checkOverbookingCap,
  checkPractitionerIsThere,
  requireOverbookingReason,
} from '../domain/overbooking-policy';
import { planReschedule } from '../domain/reschedule-policy';
import { ServiceTypeNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import { resolveDuration } from '../../../shared/domain/duration-resolution';
import {
  type AgendaTransitionTarget,
  assertNoShowNotBeforeStart,
  assertTransition,
  effectsOf,
  planAttentionEffect,
  planBlockRelease,
} from '../domain/status-machine';
import {
  type ClinicalDate,
  clinicalDateOf,
  clinicalDayBounds,
} from '../../../shared/domain/clinic-time';
import {
  type AvailabilityView,
  deriveAvailability,
} from '../domain/slot-availability';
import { bookingWarningsFor } from '../domain/holiday-calendar';
import {
  arrivalDelayMinutes,
  lateArrivalWarningsFor,
} from '../domain/late-arrival';
import {
  assertSubjectStatusMayMove,
  subjectStatusOf,
  type SubjectStatusFact,
} from '../domain/subject-status';
import {
  type NoShowReport,
  noShowWindow,
  summariseNoShow,
} from '../domain/no-show-metric';

/** Who is asking. Only the internal user id: it is what AG-029 records. */
export interface Requester {
  userId: string;
}

/**
 * AG-017, AG-018. One site's day, optionally narrowed to a practitioner or a
 * room. The date is Ecuadorian and becomes instants only inside the service
 * (AG-001), never in the client.
 */
export interface DailyAgendaRequest {
  siteId: string;
  /** The Ecuadorian calendar date, `YYYY-MM-DD`. */
  date: ClinicalDate;
  practitionerId?: string;
  roomId?: string;
  /** AG-018. Defaults to leaving released entries out. */
  includeReleased?: boolean;
}

/**
 * AG-080. A range of Ecuadorian dates and the sites the caller may see.
 *
 * NO PRACTITIONER AND NO CHANNEL FILTER: the answer already carries all three
 * breakdowns, so a filter would only let a client ask for a slice it has been
 * given — and a client that filtered server-side would compute its totals over
 * a different set from the one it displays.
 */
export interface NoShowRateRequest {
  /** The caller's resolved scope for `agenda:read`, never a site they named. */
  sites: SiteScopeFilter;
  /** Inclusive Ecuadorian calendar dates, `YYYY-MM-DD`. */
  from: ClinicalDate;
  to: ClinicalDate;
}

/**
 * The report plus the instant the count actually stopped at.
 *
 * `countedUntil` IS NOT DECORATION. AG-081 closes the window at the present
 * moment, so a period asked over the whole month on the 15th was counted over
 * half of it — and a screen that labelled the figure with the dates the user
 * typed would be stating a period the number was never computed over.
 */
export interface NoShowRateResult extends NoShowReport {
  countedUntil: Date;
}

/**
 * AG-003. One practitioner at one site over a range of dates. No room and no
 * service type: availability is derived from that practitioner's schedule
 * rules minus what is already taken.
 */
export interface AvailabilityRequest {
  siteId: string;
  practitionerId: string;
  /** Inclusive Ecuadorian calendar dates, `YYYY-MM-DD`. */
  from: ClinicalDate;
  to: ClinicalDate;
}

/**
 * One appointment as the controller hands it over. Nothing here is trusted:
 * the channel, the window, the grid and the chart are each judged by the
 * booking policy, and the author travels apart as the `Requester`.
 */
export interface BookAppointmentRequest {
  siteId: string;
  practitionerId: string;
  patientId: string;
  roomId?: string;
  startsAt: Date;
  endsAt: Date;
  /** Unvalidated: `checkBookingChannel` decides (AG-034). */
  bookingChannel: string;
  /** SP-028: the service type recepción chose, left registered on the entry. */
  serviceTypeId?: string;
  reason?: string;
  /**
   * AG-035, D-005. Present when the caller DECLARES an overbooking: the
   * documented way of booking off the grid, with a reason and somebody else's
   * authorisation.
   *
   * ITS ABSENCE IS ALSO A DECLARATION. A booking without it is judged by the
   * grid (AG-028, AG-104) and no reason or authoriser can reach the row — the
   * exception has to be asked for, never inferred from an interval that
   * happens not to fit.
   */
  overbooking?: DeclaredOverbooking;
}

/** AG-035, AG-101, AG-103: what the caller declares when breaking the grid. */
export interface DeclaredOverbooking {
  /** AG-035. Refused when empty; stored trimmed. */
  reason?: string;
  /**
   * AG-101, AG-103. The account that authorises it — never the one booking,
   * unless that person holds `agenda:overbook:self`.
   */
  authorisedById: string;
}

/**
 * AG-037, AG-038. Closing a stretch of a practitioner's agenda: leave,
 * theatre, a meeting.
 *
 * NO PATIENT AND NO CHANNEL: a block has neither, and the base says so
 * (`agenda_entry_patient_coherence`, `agenda_entry_booking_channel_coherence`).
 * NO SERVICE TYPE either — nothing is being attended.
 */
export interface BlockAgendaRequest {
  siteId: string;
  practitionerId: string;
  roomId?: string;
  startsAt: Date;
  endsAt: Date;
  /** Why the agenda is closed. Stored; not served back — see the adapter. */
  reason?: string;
}

/**
 * SP-028. What recepción has picked when it asks how long the appointment
 * would last.
 *
 * THE START TRAVELS, and it is not decoration: the third rung of SP-023 is the
 * schedule rule, and which rule governs depends on the day and the hour
 * (AG-010, AG-106). Asked without an instant, the answer would be «the minutes
 * of some rule», which is a different question from the one the screen asks.
 */
export interface DurationProposalRequest {
  siteId: string;
  practitionerId: string;
  startsAt: Date;
  /** Absent while recepción has not chosen a type: the third rung answers. */
  serviceTypeId?: string;
}

/**
 * SP-023, SP-028: how long this appointment should last, and the grid it has
 * to fit into.
 *
 * IT USED TO CARRY THE GRID TOO, and D-021 removed it (14-08-2026). That field
 * existed so the screen could warn «no encaja en los turnos de N min» before
 * the click, because SP-021 admitted any multiple of 5 and nothing tied it to
 * the practitioner's grid. Every duration is now a multiple of the site's atom
 * by the time it can be saved, so the mismatch it warned about cannot exist —
 * and a warning that can never fire is a line of screen that teaches people to
 * ignore warnings.
 */
export interface DurationProposal {
  /** `null` when no rung knows a duration: no type, and no rule open then. */
  minutes: number | null;
}

/**
 * AG-110. The appointment that WAS created, and what is worth saying about it.
 *
 * The warnings are a field of the RESULT and not an exception, because the
 * booking succeeded: an empty array is the ordinary case and means there is
 * nothing to say, never a refusal. Same shape as `RolePermissions.warnings`
 * in `auth` (AU-034), which is the precedent for «advertirlo sin impedirlo».
 */
export interface BookedAppointment {
  entry: AgendaEntryView;
  warnings: readonly string[];
}

/**
 * AG-050, AG-115. Moving one appointment to another moment — and, if it was
 * the doctor that was wrong, to another agenda.
 *
 * WHAT IS NOT HERE IS THE POINT: no patient, no room. The new entry is the old
 * one moved, so those are copied from the stored row and neither is a decision
 * this request may take — a body that could change the patient would let
 * «reprogramar» quietly hand somebody else's hour to another person.
 */
export interface RescheduleRequest {
  siteId: string;
  entryId: string;
  startsAt: Date;
  endsAt: Date;
  /** Unvalidated: `checkBookingChannel` decides (AG-034). */
  bookingChannel: string;
  /**
   * AG-115. Who will attend it now. ABSENT MEANS THE SAME ONE, which is the
   * behaviour that existed before this requirement and that it must not break.
   */
  practitionerId?: string;
  /** AG-115, SP-028. The type of attention. Absent means the stored one. */
  serviceTypeId?: string;
  /**
   * AG-044. Why the original is annulled. Required, because rescheduling IS an
   * annulment for the entry that already exists, and «anular con rastro» is
   * worth nothing if the rastro can be empty.
   */
  reason?: string;
}

/**
 * AG-050, AG-051. The two entries a reschedule leaves, and what is worth
 * saying about the new one.
 *
 * `original` comes back ANNULLED AND RELEASED, never moved: its interval is
 * the one it always had, which is what makes the history answer «¿a qué hora
 * era antes?».
 */
export interface RescheduledAppointment {
  original: AgendaEntryView;
  created: AgendaEntryView;
  /** AG-110, exactly as booking answers it. Empty is the ordinary case. */
  warnings: readonly string[];
}

/**
 * AG-040 to AG-045. One status change of one entry, plus the facts some
 * targets demand and others must not carry — see each field.
 */
export interface TransitionRequest {
  siteId: string;
  entryId: string;
  to: AgendaTransitionTarget;
  /**
   * Free text. Required by the DTO exactly when `to` is CANCELLED (AG-044) or
   * `ENTERED_IN_ERROR` (AG-117), and OPTIONAL on `LEFT_WITHOUT_BEING_SEEN`
   * (AG-116) — whoever walked out does not always say why, and a mandatory box
   * nobody can fill truthfully gets filled with anything. Whenever it comes it
   * lands in the history's `note`, and on a cancellation also in
   * `cancellation_note`. Never in a log (AG-074).
   */
  reason?: string;
  /**
   * AG-128, Ley 77 art. 10. The emergency call, REQUIRED on `CHECKED_IN` and
   * meaningless anywhere else.
   *
   * `boolean` AND NOT AN OPTIONAL FLAG: `false` is an answer — «se calificó y
   * no era una emergencia» — and its absence is the refusal. That distinction
   * is the entire point of the requirement.
   */
  emergency?: boolean;
  /**
   * AG-128. What the person who made the call wrote, when the answer was yes.
   * Health data: stored, never logged, never served back in a listing.
   */
  emergencyNote?: string;
  /**
   * AG-131, Ley 77 art. 9. Why coverage was not verified at the counter.
   *
   * ITS EXISTENCE IS THE REQUIREMENT. Art. 9 forbids demanding a cheque, card
   * or any document of payment as a condition of being received and
   * stabilised, so the check HAS to be skippable — and a skip with no reason
   * cannot be told apart from a datum somebody simply forgot.
   */
  coverageCheckSkippedReason?: string;
}

/**
 * AG-118, AG-119. What a transition answers with: the entry, the arrival delay
 * it implies, and whatever is worth saying about it.
 *
 * THE SAME SHAPE AS A BOOKING (`BookedAppointment`), and for the same reason:
 * the warnings ride in the successful response and never in a problem
 * document. Present and empty when there is nothing to say — a field that
 * appears only sometimes is a field clients forget to read.
 */
export interface TransitionOutcome {
  entry: AgendaEntryView;
  /**
   * AG-118. `checkedInAt − startsAt` in minutes, WITH ITS SIGN, or `null`
   * while nobody has arrived. Computed, never stored and never accepted as
   * input — which is what keeps it from becoming a state.
   */
  arrivalDelayMinutes: number | null;
  /** AG-119. Spanish, read by whoever registered the arrival (ADR-005). */
  warnings: string[];
}

/**
 * AG-122 to AG-127. One derived movement of the patient axis.
 *
 * NO `subjectStatus` FIELD, and that absence IS the requirement: a caller says
 * which documented fact occurred, and what the board shows for it is
 * `subjectStatusOf`'s decision. See `recordSubjectStatus` below.
 */
export interface SubjectStatusRequest {
  siteId: string;
  entryId: string;
  fact: SubjectStatusFact;
}

/**
 * Reading the day's agenda and booking into it.
 *
 * THREE USE CASES, ONE AGGREGATE. The authorisation decision is not here — the
 * guard settled it from the route's `@RequirePermission`, including the site
 * (AG-071), which is why nothing below re-reads the caller's grants.
 *
 * WHAT THIS SERVICE DOES NOT DO, and it is the load-bearing part: it never
 * asks whether a slot is free before writing. Two receptionists booking in the
 * same millisecond both read "free" and both write, so the arbitration belongs
 * to the three `EXCLUDE USING gist` constraints (AG-023, AG-024, AG-030) and
 * the adapter translates their rejection. Everything checked here is something
 * that is NOT a race: the booking channel, a merged chart, and whether the
 * interval fits a schedule rule.
 */
@Injectable()
export class AgendaService {
  constructor(
    @Inject(AGENDA_REPOSITORY)
    private readonly agenda: AgendaRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AgendaService.name);
  }

  /**
   * AG-017, AG-018. The day of one site, optionally narrowed.
   *
   * NOT AUDITED, and that is the requirement rather than an omission (AG-072,
   * SC-004): a day's list is forty rows on a screen that is open all morning,
   * and one audit row per line would bury the accesses that matter. Opening a
   * chart is the accountable act and it is audited by whoever serves it.
   */
  async dailyAgenda(request: DailyAgendaRequest): Promise<AgendaEntryView[]> {
    // AG-001: the day is delimited in Ecuador. A `::date` cast in SQL would use
    // the session's zone, and an appointment at 20:30 would fall on the next
    // day — the same arithmetic that misclassifies a neonate's age.
    const { startsAt, endsAtExclusive } = clinicalDayBounds(request.date);

    return this.agenda.dailyAgenda({
      siteId: request.siteId,
      from: startsAt,
      untilExclusive: endsAtExclusive,
      practitionerId: request.practitionerId,
      roomId: request.roomId,
      includeReleased: request.includeReleased ?? false,
    });
  }

  /**
   * AG-003, AG-010, AG-011, AG-013, AG-014. The free slots of one
   * practitioner at one site over a range of dates, and what is already taken.
   *
   * IT DERIVES, IT DOES NOT STORE. The subtraction is `deriveAvailability`,
   * the same pure function the booking path uses to know where a slot begins
   * (AG-104). A second grid computed here would be a second answer to "what
   * can I book?", and the two would disagree the day either changes — which is
   * the drift AG-003 exists to prevent.
   *
   * AG-015, AG-016, AG-093 ride in the same answer rather than in a route of
   * their own: a client that had to ask a second time whether the day is a
   * holiday would paint the grid first and contradict itself afterwards.
   *
   * NOT AUDITED PER ROW, for the same reason as the day's list (AG-072,
   * SC-004): nothing served here is clinical content.
   */
  async availability(request: AvailabilityRequest): Promise<AvailabilityView> {
    // AG-001. The range runs from the first midnight to the last, both read in
    // Ecuador: a range cut in UTC would drop a 20:30 appointment out of its own
    // day and then offer a slot that is already taken.
    const { startsAt } = clinicalDayBounds(request.from);
    const { endsAtExclusive } = clinicalDayBounds(request.to);

    /**
     * D-021, AG-094, AG-095. The grid is the SITE's now, so availability
     * resolves it exactly as booking does — same port, same chain, same
     * defaults. Asked in parallel with the context: the two answer different
     * questions and neither waits on the other.
     */
    const [{ practitioner, rules, entries, holidays, calendarYears }, stored] =
      await Promise.all([
        this.agenda.availabilityContextFor({
          practitionerId: request.practitionerId,
          siteId: request.siteId,
          fromDate: request.from,
          toDate: request.to,
          from: startsAt,
          untilExclusive: endsAtExclusive,
        }),
        this.agenda.siteParametersFor(request.siteId),
      ]);

    return deriveAvailability({
      // An identifier that matches nobody offers nothing. The fallback states
      // that explicitly rather than letting `undefined` reach the derivation.
      practitioner: practitioner ?? {
        practitionerId: request.practitionerId,
        schedulable: false,
        siteIds: [],
      },
      siteId: request.siteId,
      rules,
      entries,
      slotAtomMinutes: resolveBookingParameters(stored).slotAtomMinutes,
      // AG-015, AG-016, AG-093. Handed over as they were READ: what the site
      // observes and which years are loaded are two domain decisions, and the
      // service resolving either of them would put the rule in a second place.
      holidays,
      calendarYears,
      from: request.from,
      to: request.to,
    });
  }

  /**
   * SP-028, SP-023. How long the appointment recepción is composing should
   * last, resolved through the hierarchy of D-010.
   *
   * IT PROPOSES; IT DOES NOT BOOK, and the wording of SP-028 is what draws
   * that line: «DEBERÁ proponer la duración resuelta». Nothing is written
   * here, and `book` below does not re-impose this number on the interval it
   * receives — a doctor who shortens one control has not broken a requirement,
   * and no requirement says the length of a booked appointment must equal the
   * type's duration at booking time. What the two share is the FUNCTION, so
   * the number recepción is shown and the number any other caller resolves
   * cannot be two different numbers.
   *
   * NOT AUDITED: nothing clinical is served — a practitioner, a type of visit
   * and a count of minutes (AG-072, SC-004).
   */
  async proposeDuration(
    request: DurationProposalRequest,
  ): Promise<DurationProposal> {
    // The rules are wall clock, so they are read for the ECUADORIAN date of
    // the instant asked about (AG-001), exactly as booking does.
    const [{ rules }, storedParameters] = await Promise.all([
      this.agenda.scheduleContextFor({
        practitionerId: request.practitionerId,
        siteId: request.siteId,
        date: clinicalDateOf(request.startsAt),
      }),
      this.agenda.siteParametersFor(request.siteId),
    ]);
    const parameters = resolveBookingParameters(storedParameters);

    // AG-106 decides which one when two are in force; `null` means none is
    // open then, which costs the third rung and nothing else.
    const rule = ruleGoverningStart(rules, {
      practitionerId: request.practitionerId,
      siteId: request.siteId,
      startsAt: request.startsAt,
    });

    let stored = null;
    if (request.serviceTypeId !== undefined) {
      stored = await this.agenda.durationSourcesFor({
        practitionerId: request.practitionerId,
        serviceTypeId: request.serviceTypeId,
      });
      // A type that does not exist is a missing resource, not a duration of
      // zero: answering the rule's minutes instead would quietly propose the
      // wrong length for a type nobody has.
      if (stored === null) throw new ServiceTypeNotFoundError();
    }

    return {
      // SP-023, in the one place the order is written: exception → base →
      // rule. Both stored rungs are absent while no type is chosen, so the
      // proposal is the grid's own slot — which is what the screen books
      // today, and what makes «sin tipo» a case rather than an omission.
      minutes: resolveDuration({
        exceptionMinutes: stored?.exceptionMinutes,
        serviceTypeMinutes: stored?.serviceTypeMinutes,
        /**
         * SP-023's third rung, which D-021 moved from the rule to the site.
         * IT IS STILL GATED ON A RULE BEING OPEN: the site has an atom at
         * every hour of the week, and proposing «10 minutos» for a Sunday
         * midnight nobody works would answer a question about the clinic's
         * grid when the one asked was about this practitioner's agenda.
         */
        ruleSlotMinutes: rule === null ? null : parameters.slotAtomMinutes,
      }),
    };
  }

  /**
   * AG-020, AG-029. Books an appointment.
   *
   * ORDER OF THE CHECKS, and why. The channel first because it costs nothing
   * and a typo there needs no database at all. The site's booking window next
   * (AG-031 to AG-033): it is one row by primary key, and refusing "that hour
   * already passed" before reading a chart is both cheaper and the answer a
   * receptionist can act on. The merged chart next, because refusing at the
   * end would mean she finds out only after the schedule was read. The
   * schedule last, since it is the one that needs the rules. The overlap is
   * never checked: it is written and arbitrated.
   *
   * THE HOLIDAY IS NOT IN THAT LIST, and it is not an omission (AG-110,
   * D-019). A closed day does not refuse anything: it is read AFTER the write
   * and answered as a warning, because the clinic works many holidays and
   * refusing would push the case out of the system.
   */
  async book(
    request: BookAppointmentRequest,
    requester: Requester,
  ): Promise<BookedAppointment> {
    // Taken ONCE and handed to the pure policy, exactly as `transition` does:
    // the domain owns no clock, and two readings of `new Date()` inside one
    // booking could straddle a minute and judge the same request twice.
    const now = new Date();

    // AG-034. Returns the channel or refuses; there is no default, because
    // AG-080 reports by channel and an invented value reports a lie.
    const bookingChannel = checkBookingChannel(request.bookingChannel);

    /**
     * AG-035, AG-039, AG-100, AG-101, AG-103. Everything the exception has to
     * satisfy is decided HERE, before the insert, and what comes back is the
     * record that will be written with it — the reason already trimmed and the
     * authoriser already checked.
     *
     * `undefined` when no overbooking was declared, and then the row is
     * written the ordinary way. Nothing below infers an overbooking from an
     * interval that does not fit.
     */
    const overbooking = await this.checkIntervalIsBookable({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      patientId: request.patientId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      channel: bookingChannel,
      overbooking: request.overbooking,
      requesterId: requester.userId,
      now,
    });

    const entry = await this.agenda.book({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      patientId: request.patientId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      bookingChannel,
      // SP-028, second half: the type stays ON the appointment. The duration
      // it produced is already in `startsAt`/`endsAt`, and that is what makes
      // SP-024 true without a line of code — the stored interval owes nothing
      // to what the type's base duration says tomorrow.
      serviceTypeId: request.serviceTypeId,
      reason: request.reason,
      createdById: requester.userId,
      // AG-035, AG-036: the three fields of the exception travel together, or
      // the row is an ordinary appointment.
      overbooking,
    });

    /**
     * AG-074. The site and the fact, and nothing else.
     *
     * No patient identifier, no practitioner, no reason for the visit: "sabe
     * que hay una cita" is operational, "sabe quién va a qué" is health data.
     * Nothing is interpolated into the message either — the logger prunes by
     * allowlist, and a template string walks straight past it.
     */
    this.logger.info(
      { site_id: entry.siteId, action: 'AGENDA_ENTRY_BOOKED' },
      'appointment booked',
    );

    /**
     * AG-110. Said about the appointment THAT EXISTS, and only now.
     *
     * THE ORDER IS THE REQUIREMENT. Read before the insert, this would be a
     * warning about a booking that a constraint may still refuse — a sentence
     * about an appointment nobody has. Read here, it describes the stored row:
     * its site and the Ecuadorian date of its stored instant (AG-001), not the
     * ones that were asked for.
     *
     * NOTHING BRANCHES ON IT. The warning cannot turn into a refusal further
     * down, because there is no further down: the entry is already written and
     * the answer is a 201 either way.
     */
    const bookedDate = clinicalDateOf(entry.startsAt);
    const warnings = bookingWarningsFor(
      await this.agenda.holidaysFor({
        siteId: entry.siteId,
        date: bookedDate,
      }),
      bookedDate,
      entry.siteId,
    );

    return { entry, warnings };
  }

  /**
   * Everything that has to be true about an interval before it is written, and
   * that is NOT a race: AG-031 to AG-033, AG-027, AG-105, AG-012 to AG-014,
   * AG-028 and AG-104.
   *
   * SHARED BY BOOKING AND BY RESCHEDULING, and not by symmetry: the second
   * writes exactly the same kind of row as the first, so a copy of these
   * checks would mean the day one of them changes, one route enforces the
   * site's booking window and the other does not — an appointment moved to an
   * hour the same site refuses to book. The overlap is not among them: it is
   * written and arbitrated.
   *
   * THE ORDER IS THE CHEAPEST AND MOST ACTIONABLE FIRST. The site's booking
   * window is one row by primary key, and refusing "that hour already passed"
   * before reading a chart is both cheaper and the answer a receptionist can
   * act on. The merged chart next, because refusing at the end would mean she
   * finds out only after the schedule was read. The schedule last, since it is
   * the one that needs the rules.
   */
  private async checkIntervalIsBookable(input: {
    siteId: string;
    practitionerId: string;
    patientId: string;
    roomId?: string;
    startsAt: Date;
    endsAt: Date;
    channel: BookingChannel;
    /** AG-035. Absent on an ordinary booking and on every reschedule. */
    overbooking?: DeclaredOverbooking;
    /** AG-103. From the session, so the two people can be compared. */
    requesterId?: string;
    now: Date;
  }): Promise<OverbookingRecord | undefined> {
    /**
     * AG-031, AG-032, AG-033 against the parameters of THIS site (AG-094),
     * completed with the code defaults for whatever it does not state
     * (AG-095).
     *
     * AG-098 IS THIS LINE'S DOING, and it is worth naming: the parameters are
     * read at the instant of booking and applied to the booking being made.
     * Nothing here — and nothing anywhere in the module — walks the entries
     * that already exist, so changing the minimum lead cannot cancel,
     * revalidate or move an appointment somebody already has. The requirement
     * is satisfied by there being no such code path, which is why the test
     * for it asserts on stored rows rather than on a function.
     */
    const parameters = resolveBookingParameters(
      await this.agenda.siteParametersFor(input.siteId),
    );

    checkBookingWindow({
      startsAt: input.startsAt,
      now: input.now,
      channel: input.channel,
      parameters,
    });

    /**
     * AG-039 and AG-035, in that order and before any further read.
     *
     * THE SWITCH FIRST: if this site does not do overbookings there is nothing
     * to say about the reason, the authoriser or the cap — checking them would
     * answer «falta el motivo» about an exception the site refuses outright.
     * Both are pure and the parameters are already in hand, so a refusal here
     * costs no round trip at all.
     */
    let reason: string | undefined;
    if (input.overbooking !== undefined) {
      assertOverbookingAdmitted(parameters);
      reason = requireOverbookingReason(input.overbooking.reason);
    }

    /**
     * AG-027. A merged chart is refused with the surviving number.
     *
     * A patient that does NOT exist is deliberately not refused here: the
     * foreign key does it, at write time, without a read that a concurrent
     * merge could invalidate. Answering "not found" from here would also make
     * the endpoint an oracle for guessed identifiers.
     */
    const patient = await this.agenda.findPatientForBooking(input.patientId);
    if (patient?.mergedIntoMrn) {
      throw new PatientMergedError(patient.mergedIntoMrn);
    }

    /**
     * AG-071 through the body of the request.
     *
     * The site is in the path so the guard can settle the caller's scope
     * before any pipe runs — and the room went straight past it, because
     * nothing in the schema ties `agenda_entry.room_id` to
     * `agenda_entry.site_id`. Booking a room of another site occupies a
     * physical resource nobody here has scope over, and the entry never shows
     * on that site's agenda, which filters by `site_id`: the room looks free
     * and `agenda_entry_no_room_overlap` then refuses its legitimate booking
     * with nothing to explain why.
     *
     * IT IS AN APPLICATION CHECK BECAUSE THE DATABASE CANNOT ANSWER IT YET.
     * The lasting guarantee is a composite foreign key against
     * `site_room(id, site_id)`, and that is a migration.
     */
    if (input.roomId !== undefined) {
      checkRoomBelongsToSite(
        await this.agenda.roomSiteOf(input.roomId),
        input.siteId,
      );
    }

    // The weekly rules are wall clock, so they are read for the ECUADORIAN
    // date of the requested start: read in UTC, a 20:00 appointment would be
    // matched against the next day's rules.
    const { practitioner, rules } = await this.agenda.scheduleContextFor({
      practitionerId: input.practitionerId,
      siteId: input.siteId,
      date: clinicalDateOf(input.startsAt),
    });

    // AG-012, AG-013, AG-014, AG-028 and AG-104 in one pure call. A declared
    // overbooking excuses AG-028 and AG-104 — being off the grid is the whole
    // point of it — and NOTHING else: the practitioner still has to be
    // bookable and the duration still has to fit the site's atom.
    checkBookingFitsSchedule({
      request: {
        practitionerId: input.practitionerId,
        siteId: input.siteId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
      rules,
      // D-021. The grid AG-012 and AG-104 judge against is the site's, read on
      // the same round trip and through the same AG-095 chain as the window.
      slotAtomMinutes: parameters.slotAtomMinutes,
      practitioner: practitioner ?? {
        practitionerId: input.practitionerId,
        schedulable: false,
        siteIds: [],
      },
      overbookingDeclared: input.overbooking !== undefined,
    });

    if (input.overbooking === undefined || reason === undefined) return undefined; // prettier-ignore

    /**
     * AG-151 (D-069). The overbooking squeezes somebody into the consultation
     * of a practitioner WHO IS THERE: not on top of a block, and not where
     * they are at another site. After the grid check because that one is
     * pure and already in hand; before the authoriser, because «la médica no
     * está» is the answer the receptionist acts on first.
     */
    checkPractitionerIsThere({
      siteId: input.siteId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      ...(await this.agenda.presenceOf({
        practitionerId: input.practitionerId,
        siteId: input.siteId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        date: clinicalDateOf(input.startsAt),
      })),
    });

    return this.authoriseOverbooking({
      siteId: input.siteId,
      practitionerId: input.practitionerId,
      startsAt: input.startsAt,
      authorisedById: input.overbooking.authorisedById,
      requesterId: input.requesterId,
      reason,
      parameters,
    });
  }

  /**
   * AG-100, AG-101, AG-103. The two questions an overbooking cannot answer on
   * its own: may this person authorise it, and does it still fit under the
   * cap of that day.
   *
   * THE TWO READS GO TOGETHER because neither depends on the other and both
   * are on the path of an urgency, where the person at the counter is waiting.
   *
   * THE ORDER OF THE REFUSALS IS NOT THE ORDER OF THE READS. Authorisation is
   * judged first: «pídaselo al médico» is something recepción can do right
   * now, while «ya no caben más hoy» ends the conversation — and hearing the
   * second when the first is also true would send her to authorise a booking
   * that was never going to be accepted.
   *
   * NOTHING IS WRITTEN HERE (AG-101 says so literally: «NO DEBERÁ crear la
   * entrada»). What comes back is the record the insert will carry.
   */
  private async authoriseOverbooking(input: {
    siteId: string;
    practitionerId: string;
    startsAt: Date;
    authorisedById: string;
    requesterId?: string;
    reason: string;
    parameters: SiteBookingParameters;
  }): Promise<OverbookingRecord> {
    /**
     * AG-100, AG-001. The cap is counted over the CLINICAL date of the start,
     * delimited in `America/Guayaquil` — never with a `::date` in SQL, which
     * uses the session's zone: an overbooking at 19:30 would then count
     * against the following day and the cap would stop limiting the evenings,
     * which is exactly when it gets abused.
     */
    const { startsAt, endsAtExclusive } = clinicalDayBounds(
      clinicalDateOf(input.startsAt),
    );

    const [permissions, used] = await Promise.all([
      this.agenda.authoriserPermissions({
        userId: input.authorisedById,
        siteId: input.siteId,
      }),
      this.agenda.overbookingCount({
        siteId: input.siteId,
        practitionerId: input.practitionerId,
        from: startsAt,
        untilExclusive: endsAtExclusive,
      }),
    ]);

    checkOverbookingAuthoriser({
      authorisedById: input.authorisedById,
      // An overbooking always has a requester: `book` is the only caller and
      // it takes the id from the session. The fallback states that rather than
      // letting `undefined` compare equal to nothing and quietly skip AG-103.
      requesterId: input.requesterId ?? '',
      authoriserPermissions: permissions,
      requiredPermission: input.parameters.overbookingPermission,
    });

    checkOverbookingCap({ used, cap: input.parameters.overbookingCap });

    return { reason: input.reason, authorisedById: input.authorisedById };
  }

  /**
   * AG-037, AG-038. Closes a stretch of a practitioner's agenda.
   *
   * WHAT IT DOES NOT CHECK, and why. Not the schedule rules: a block for leave
   * or for a public holiday is precisely an interval no rule covers, and
   * demanding one would make the feature unable to express its main case. Not
   * the booking window either — closing a morning that already passed changes
   * nothing for anybody, and AG-031 to AG-033 are about «la reserva».
   *
   * WHAT IT DOES CHECK: that the room belongs to the site (AG-105, the same
   * hole a booking has), and that no appointment stands inside the interval
   * (AG-038) — which is a READ, and is why the `EXCLUDE` is still what decides
   * (AG-037). The read can go stale between here and the insert; when it does,
   * PostgreSQL refuses the block and the client gets
   * `PRACTITIONER_SLOT_TAKEN`. What the read buys is the LIST, which a
   * constraint rejection cannot give.
   */
  async blockAgenda(
    request: BlockAgendaRequest,
    requester: Requester,
  ): Promise<AgendaEntryView> {
    // AG-105, through the body of the request, exactly as booking does.
    if (request.roomId !== undefined) {
      checkRoomBelongsToSite(
        await this.agenda.roomSiteOf(request.roomId),
        request.siteId,
      );
    }

    const blocking = await this.agenda.blockingAppointments({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
    });
    if (blocking.length > 0) {
      // AG-038. Identifiers and hours only: what may be said of somebody
      // else's appointment in a message that reaches the logs (AG-074).
      throw new BlockOverlapsAppointmentsError(blocking);
    }

    const entry = await this.agenda.blockAgenda({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      reason: request.reason ?? '',
      createdById: requester.userId,
    });

    // AG-074. The site and the fact. A block names no patient by definition,
    // and the practitioner is still not log material. Nothing interpolated.
    this.logger.info(
      { site_id: entry.siteId, action: 'AGENDA_BLOCKED' },
      'agenda blocked',
    );

    return entry;
  }

  /**
   * AG-114. Undoes a block: the interval comes back and the row stays.
   *
   * THE SAME PORT AS A TRANSITION, and that is the point rather than a
   * shortcut. `transition` already reads inside the transaction, hands the row
   * to a pure decision, re-arbitrates the write on what it read and writes the
   * history row beside it (AG-004, AG-005) — everything AG-114 needs, and
   * everything a second path would have to reimplement and eventually get
   * wrong. What changes is only WHICH rule judges the row: `planBlockRelease`
   * instead of the appointment table of SPEC §5.
   *
   * NOTHING IS DELETED HERE OR ANYWHERE. `releasedAt` is what both `EXCLUDE`
   * constraints look at, so the hour is free the moment it is stamped, and the
   * row keeps saying that this interval was closed and by whom.
   */
  async releaseBlock(
    request: { siteId: string; entryId: string },
    requester: Requester,
  ): Promise<AgendaEntryView> {
    // Taken ONCE and handed to the pure policy, like `book` and `transition`:
    // the same instant stamps `cancelled_at` and `released_at`.
    const now = new Date();

    const entry = await this.agenda.transition(
      {
        siteId: request.siteId,
        entryId: request.entryId,
        // AG-004, AG-114: who undid it comes from the session, never from the
        // request — «quién lo eliminó» is worth nothing if a client picks it.
        changedById: requester.userId,
      },
      (read) => planBlockRelease(read, now),
    );

    // AG-074. The site and the fact. A block names no patient by definition.
    this.logger.info(
      { site_id: entry.siteId, action: 'AGENDA_BLOCK_RELEASED' },
      'agenda block released',
    );

    return entry;
  }

  /**
   * AG-050, AG-051, AG-052. Moves one appointment to another moment.
   *
   * ONE PORT CALL, AND THAT IS THE REQUIREMENT. This method could annul
   * through `transition` and then book through `book`, and AG-052 exists to
   * forbid exactly that: the second call is refused every time the destination
   * is taken, and by then the first has committed and the patient has no
   * appointment at all. So the release and the creation travel together to
   * `reschedule`, which does both in one transaction or neither.
   *
   * WHAT IS CHECKED BEFORE THE TRANSACTION and what is not. The new interval
   * is judged by the same checks a fresh booking gets — the site's window, the
   * merged chart, the room, the schedule — because it IS a fresh booking. The
   * overlap is never checked: the three `EXCLUDE` constraints arbitrate it,
   * and their rejection is what AG-052 turns into "nothing was released".
   */
  async reschedule(
    request: RescheduleRequest,
    requester: Requester,
  ): Promise<RescheduledAppointment> {
    // Taken ONCE, like `book` and `transition`: the same instant stamps the
    // annulment of the original and judges the window of the new interval.
    const now = new Date();

    const bookingChannel = checkBookingChannel(request.bookingChannel);

    // AG-044 before any read, exactly as `transition` does: a refusal that
    // costs a round trip is a worse refusal. The policy demands it again
    // inside the transaction, where no caller can walk around it.
    if (!request.reason?.trim()) throw new CancellationReasonRequiredError();

    const original = await this.agenda.findEntry({
      siteId: request.siteId,
      entryId: request.entryId,
    });
    // AG-071: one answer for "does not exist" and for "belongs to another
    // site". Telling them apart confirms foreign entries one guess at a time.
    if (original === null) throw new AgendaEntryNotFoundError();

    /**
     * AG-040, AG-046 early, and AUTHORITATIVELY LATER. A block has no patient
     * to move and a terminal appointment has nothing left to move; refusing
     * here saves reading a schedule for a request that cannot succeed. The
     * decision that counts is the same rule re-run inside the transaction,
     * over the row as it is there.
     */
    assertTransition(original.kind, original.status, 'CANCELLED');
    if (original.patientId === null) {
      // Unreachable while `agenda_entry_patient_coherence` holds — an
      // APPOINTMENT has a patient — and stated rather than asserted away: a
      // row that broke the CHECK must be refused, not rescheduled onto nobody.
      throw new InvalidAgendaTransitionError(original.status, 'CANCELLED');
    }

    /**
     * AG-115. What the NEW entry will be, resolved once and used twice.
     *
     * THE FALLBACK IS THE REQUIREMENT'S «opcionales»: absent means the one it
     * already had, so a reschedule that only moves the hour behaves exactly as
     * it did before AG-115 existed. The patient is NOT in this list and has no
     * fallback to write: it is copied by the adapter and no caller can name it.
     */
    const practitionerId = request.practitionerId ?? original.practitionerId;
    const serviceTypeId = request.serviceTypeId ?? original.serviceTypeId;

    /**
     * AG-115's second half: «las mismas comprobaciones que a una reserva», and
     * against the practitioner who will ATTEND. Judging the schedule of the
     * doctor being left would place an appointment on a grid the booking route
     * refuses — the exact reason these checks are shared with `book` instead of
     * copied (see `checkIntervalIsBookable`).
     */
    await this.checkIntervalIsBookable({
      siteId: request.siteId,
      practitionerId,
      patientId: original.patientId,
      // The new entry keeps the room of the old one, so it is the room whose
      // site has to be checked (AG-105) — even though nobody chose it now.
      roomId: original.roomId ?? undefined,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      channel: bookingChannel,
      now,
    });

    const outcome = await this.agenda.reschedule(
      {
        siteId: request.siteId,
        entryId: request.entryId,
        // AG-004, AG-029: whoever moved it authors both the history row and
        // the new entry. From the session, never from the body.
        changedById: requester.userId,
      },
      {
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        bookingChannel,
        practitionerId,
        serviceTypeId,
      },
      (read) => planReschedule({ entry: read, reason: request.reason, now }),
    );

    /**
     * AG-074. The site and the fact. No patient, no practitioner, no hour:
     * "una cita se movió en esta sede" is operational, who moved to when is
     * not. Nothing is interpolated — the logger prunes by allowlist.
     */
    this.logger.info(
      { site_id: outcome.created.siteId, action: 'AGENDA_ENTRY_RESCHEDULED' },
      'appointment rescheduled',
    );

    /**
     * AG-110, read about the entry THAT EXISTS and on the date it was STORED
     * on, exactly as booking does. Rescheduling onto a closed day is the same
     * legitimate act as booking onto one, and answering it differently here
     * would be the second answer to "¿está cerrado ese día?" that AG-110 was
     * written to prevent.
     */
    const bookedDate = clinicalDateOf(outcome.created.startsAt);
    const warnings = bookingWarningsFor(
      await this.agenda.holidaysFor({
        siteId: outcome.created.siteId,
        date: bookedDate,
      }),
      bookedDate,
      outcome.created.siteId,
    );

    return { ...outcome, warnings };
  }

  /**
   * AG-040 to AG-045. One status transition of one appointment.
   *
   * THE POLICY IS A CLOSURE handed to the port, and the shape is deliberate:
   * the rules live here, but they must judge the row as it is INSIDE the
   * adapter's transaction — a read from a moment earlier is exactly what two
   * receptionists resolving the same appointment would both act on. The
   * adapter still re-arbitrates the write with a conditional update, so even
   * a stale decision loses honestly (AG-025's reasoning, applied to states).
   *
   * `now` is taken ONCE, here, and handed down: the machine is pure (no
   * clock in the domain), and one instant stamping `checked_in_at` and
   * `released_at` alike is what makes the history reconstructible.
   */
  async transition(
    request: TransitionRequest,
    requester: Requester,
  ): Promise<TransitionOutcome> {
    const now = new Date();
    let from: AgendaEntryStatus | undefined;

    /**
     * THE THREE REFUSALS THAT COST NOTHING GO FIRST, before any read: a
     * refusal that spends a transaction is a worse refusal. All three live
     * HERE and not only in the DTO (adversarial review of E2, P2-3) — E3
     * cancels the original entry from inside this service, and a DEBERÁ that
     * only the HTTP boundary enforces stops being enforced the day another
     * use case calls in.
     */
    // AG-044: an annulment is a decision about an appointment that existed,
    // and the patient is owed the explanation.
    if (request.to === 'CANCELLED' && !request.reason?.trim()) {
      throw new CancellationReasonRequiredError();
    }
    // AG-117: and a retraction says the recorded fact never happened, which
    // without a reason is a door for making appointments disappear.
    if (request.to === 'ENTERED_IN_ERROR' && !request.reason?.trim()) {
      throw new EnteredInErrorReasonRequiredError();
    }
    /**
     * AG-128, Ley 77 art. 10. No arrival is recorded without the emergency
     * call having been made, affirmatively or negatively, by somebody.
     *
     * `undefined` AND NOT FALSY: `false` is a legitimate answer and the most
     * common one. Testing truthiness here would refuse every ordinary arrival
     * and, worse, would make «no era una emergencia» unrecordable — which is
     * the half of art. 10 that proves the call happened at all.
     */
    if (request.to === 'CHECKED_IN' && request.emergency === undefined) {
      throw new EmergencyAssessmentRequiredError();
    }

    const entry = await this.agenda.transition(
      {
        siteId: request.siteId,
        entryId: request.entryId,
        changedById: requester.userId,
      },
      (read) => {
        from = read.status;
        // AG-040, AG-046, AG-116, AG-117: the table of SPEC §5. It is what
        // refuses `CHECKED_IN → NO_SHOW`, `ENTERED_IN_ERROR` after an
        // arrival, and `LEFT_WITHOUT_BEING_SEEN` from anywhere but the
        // waiting room. BLOCKED is blocks-only.
        assertTransition(read.kind, read.status, request.to);
        // AG-043: nobody is a no-show before the appointment starts.
        if (request.to === 'NO_SHOW') {
          assertNoShowNotBeforeStart(read.startsAt, now);
        }
        /**
         * AG-045, AG-148: a documented attention outweighs the agenda. A live
         * attention forbids annulling, the no-show and the retraction; it
         * allows «se fue sin ser atendido» only while no note exists, and then
         * the attention is interrupted in the same transaction (D-081).
         */
        const interruptAttention = planAttentionEffect(
          read,
          request.to,
          request.reason,
          now,
        );

        return {
          to: request.to,
          effects: {
            ...effectsOf(request.to, now),
            // AG-128, AG-131. Only an arrival carries them, and the arrival
            // always carries the assessment.
            ...(request.to === 'CHECKED_IN'
              ? this.arrivalRecord(request, requester, now)
              : {}),
            /**
             * AG-116, AG-117. The reason lands in the outcome's OWN column,
             * never in `cancellation_note`.
             *
             * Since `20260820121023_agenda_outcomes_and_board` the database
             * refuses a retraction without one
             * (`agenda_entry_entered_in_error_states_a_reason`), so the check
             * above is no longer the only thing standing between «esta cita
             * nunca ocurrió» and a row nobody can explain.
             */
            ...(request.to === 'LEFT_WITHOUT_BEING_SEEN'
              ? {
                  leftWithoutBeingSeenReason:
                    request.reason?.trim() || undefined,
                }
              : {}),
            ...(request.to === 'ENTERED_IN_ERROR'
              ? { enteredInErrorReason: request.reason?.trim() }
              : {}),
          },
          // AG-044: the reason lands on the entry only when it is annulled.
          // AG-117 does NOT borrow this column — see `effectsOf`.
          cancellationNote:
            request.to === 'CANCELLED' ? request.reason : undefined,
          // AG-004: and in the history whenever the caller gave one. It is
          // where the optional reason of AG-116 and the required one of
          // AG-117 both land, with who wrote it and when.
          historyNote: request.reason,
          interruptAttention,
        };
      },
    );

    /**
     * AG-074. Site, action and the two states, in stable codes. No patient,
     * no reason: "la cita pasó a otra sala" is operational, who missed which
     * doctor is health data.
     *
     * AND NOT THE EMERGENCY CALL EITHER. Whether this particular person
     * arrived in an emergency is a statement about their condition, which is
     * health data (AG-074); its record is the row, not the log.
     */
    this.logger.info(
      {
        site_id: entry.siteId,
        action: 'AGENDA_STATUS_CHANGED',
        from_status: from,
        to_status: request.to,
      },
      'agenda entry status changed',
    );

    /**
     * AG-118, AG-119. The delay is computed from the row that came back and
     * the threshold the site has stored, and the warning rides in the
     * successful response.
     *
     * THE PARAMETERS ARE READ ONLY ON AN ARRIVAL, and after the write rather
     * than before it: nothing about this decides whether the arrival is
     * recorded — AG-119 says so in as many words, and the reason is AG-128.
     * A check-in that can be refused is a check-in that some day does not
     * happen, and with it goes the assessment art. 13 backs with prison.
     */
    const delay = arrivalDelayMinutes(entry);
    if (request.to !== 'CHECKED_IN') {
      return { entry, arrivalDelayMinutes: delay, warnings: [] };
    }

    const parameters = resolveBookingParameters(
      await this.agenda.siteParametersFor(request.siteId),
    );

    return {
      entry,
      arrivalDelayMinutes: delay,
      warnings: lateArrivalWarningsFor(
        delay,
        parameters.lateArrivalGraceMinutes,
      ),
    };
  }

  /**
   * AG-128, AG-130, AG-131. What an arrival records besides the hour: the
   * article-10 call, its outcome, and why coverage was not checked.
   *
   * THE ACT AND ITS OUTCOME ARE DIFFERENT COLUMNS, and that is the correction
   * `20260820055257_emergency_assessment_and_names` exists for. Written only
   * on the flag, `NULL` cannot tell «se calificó y no era una emergencia» from
   * «nadie calificó nada», and it is the second that art. 13 turns into a
   * prison sentence — proving it for the flagged patients says nothing about
   * the one who was waved through.
   *
   * NO PERMISSION OF ITS OWN (AG-130). The route's `agenda:write` is the one
   * that registers the arrival and it is the one that registers this: a
   * permission of its own would mean receptionists who cannot make the call,
   * and then art. 10 goes unmet on the days that person is at the counter.
   *
   * THE AUTHOR IS THE SESSION, never a body field, like every author in this
   * module (AG-004): whoever made the call is whoever is logged in.
   */
  private arrivalRecord(
    request: TransitionRequest,
    requester: Requester,
    now: Date,
  ) {
    return {
      // The act, unconditionally. The service already refused an arrival that
      // did not carry it.
      emergencyAssessedAt: now,
      emergencyAssessedById: requester.userId,
      // The outcome, only when it was affirmative —
      // `agenda_entry_emergency_flag_follows_assessment` refuses a flag with
      // no assessment behind it, and the pairing above is what satisfies it.
      ...(request.emergency === true
        ? {
            emergencyFlaggedAt: now,
            emergencyFlaggedById: requester.userId,
            emergencyNote: request.emergencyNote,
          }
        : {}),
      // AG-131. Present exactly when somebody said why, absent otherwise:
      // there is nothing to record about a coverage check that was done.
      ...(request.coverageCheckSkippedReason
        ? { coverageCheckSkippedReason: request.coverageCheckSkippedReason }
        : {}),
    };
  }

  /**
   * AG-122 to AG-127. Moves the PATIENT axis from a documented fact.
   *
   * NO ROUTE REACHES THIS, and that is the requirement rather than an
   * unfinished edge: AG-122 forbids exposing any route that sets
   * `IN_PREPARATION`, `READY`, `RECEIVING_CARE`, `ON_LEAVE` or `DEPARTED`,
   * because a board that can be typed is a board that drifts from the record —
   * the single most replicated finding in the literature on clinical
   * whiteboards. The callers are the documented facts of `encounter`, a module
   * that has no code yet; AG-121 to AG-127 depend on it and not the reverse.
   *
   * `ARRIVED` DOES NOT COME THROUGH HERE. It is written by the check-in effect
   * (`effectsOf`), because the fact it stands for — the person crossed the
   * door — leaves no other trace in the system and therefore has nothing to be
   * derived from.
   */
  async recordSubjectStatus(
    request: SubjectStatusRequest,
    requester: Requester,
  ): Promise<AgendaEntryView> {
    const entry = await this.agenda.recordSubjectStatus(
      {
        siteId: request.siteId,
        entryId: request.entryId,
        changedById: requester.userId,
        fact: request.fact,
        // Taken ONCE here, like every other instant in this service: the
        // domain owns no clock.
        at: new Date(),
      },
      // The policy judges the row as it is INSIDE the transaction, exactly as
      // `transition` does and for the same reason.
      (read) => {
        // AG-125, AG-127, AG-021: not before arrival, not after departure,
        // never on a block.
        assertSubjectStatusMayMove(read);
        return subjectStatusOf(request.fact);
      },
    );

    /**
     * AG-074. The fact and the state it derived, in stable codes. Not the
     * patient: where a named person is standing is health data.
     */
    this.logger.info(
      {
        site_id: entry.siteId,
        action: 'AGENDA_SUBJECT_STATUS_CHANGED',
        fact: request.fact,
        to_status: subjectStatusOf(request.fact),
      },
      'patient subject status derived from a documented fact',
    );

    return entry;
  }

  /**
   * AG-107. The sites the CALLER may schedule in — the scope is the filter.
   *
   * The route declares `'query'` site scope, which means the guard cannot
   * narrow it and this method is the narrowing. Passing anything other than
   * the caller's own resolved scope here is the bug this comment exists to
   * prevent.
   */
  async sitesFor(scope: SiteScopeFilter) {
    return this.agenda.listSites(scope);
  }

  /**
   * AG-108, AG-111. Selector data: names, their specialties, and deliberately
   * nothing else.
   */
  async schedulablePractitioners(siteId: string) {
    return this.agenda.listSchedulablePractitioners(siteId);
  }

  /**
   * AG-080, AG-081. The inasistencia rate of a range, cut three ways.
   *
   * THE CLOCK IS READ ONCE, HERE. `noShowWindow` needs «now» to close the
   * range at the last appointment that has actually had the chance to be
   * missed (AG-081), and the domain owns no clock — two readings inside one
   * request could straddle a minute and put the same appointment on both sides
   * of the boundary.
   *
   * THE SCOPE IS A PARAMETER AND NOT A SITE ID: the route declares `'query'`
   * because AG-080 asks for the breakdown BY SITE, and a metric rooted at
   * `/sites/:siteId` could not answer that at all. Passing anything other than
   * the caller's own resolved scope here is the bug this comment exists to
   * prevent — it is the only thing standing between a receptionist of Norte
   * and the figures of Sur (AG-071).
   */
  async noShowRate(request: NoShowRateRequest): Promise<NoShowRateResult> {
    const window = noShowWindow(request.from, request.to, new Date());

    const rows = await this.agenda.noShowCounts({
      sites: request.sites,
      from: window.from,
      untilExclusive: window.untilExclusive,
    });

    return { ...summariseNoShow(rows), countedUntil: window.untilExclusive };
  }

  /**
   * AG-112. The attention types of one specialty, for the booking dialog.
   *
   * THE SITE IS NOT A PARAMETER HERE, and that is not an oversight: a
   * `service_type` has no site and never had one (SP-021), so there is nothing
   * to filter by. The site lives in the ROUTE so the guard can settle the
   * caller's scope before any pipe runs (AG-071), and passing it down would be
   * pretending it narrows something.
   */
  async serviceTypesOf(specialtyId: string) {
    return this.agenda.listServiceTypes(specialtyId);
  }
}
