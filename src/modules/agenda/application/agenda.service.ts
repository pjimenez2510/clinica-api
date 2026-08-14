import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  AGENDA_REPOSITORY,
  type AgendaEntryStatus,
  type AgendaEntryView,
  type AgendaRepository,
  type SiteScopeFilter,
} from '../domain/agenda.repository';
import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  CancellationReasonRequiredError,
  InvalidAgendaTransitionError,
} from '../domain/agenda.errors';
import { checkBookingChannel, checkBookingFitsSchedule, checkBookingWindow, checkRoomBelongsToSite, resolveBookingParameters, ruleGoverningStart, type BookingChannel } from '../domain/booking-policy'; // prettier-ignore
import { planReschedule } from '../domain/reschedule-policy';
import { ServiceTypeNotFoundError } from '../../../shared/domain/errors/master-data.errors';
import { resolveDuration } from '../../../shared/domain/duration-resolution';
import {
  type AgendaTransitionTarget,
  assertNoShowNotBeforeStart,
  assertTransition,
  effectsOf,
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

/** Who is asking. Only the internal user id: it is what AG-029 records. */
export interface Requester {
  userId: string;
}

export interface DailyAgendaRequest {
  siteId: string;
  /** The Ecuadorian calendar date, `YYYY-MM-DD`. */
  date: ClinicalDate;
  practitionerId?: string;
  roomId?: string;
  /** AG-018. Defaults to leaving released entries out. */
  includeReleased?: boolean;
}

export interface AvailabilityRequest {
  siteId: string;
  practitionerId: string;
  /** Inclusive Ecuadorian calendar dates, `YYYY-MM-DD`. */
  from: ClinicalDate;
  to: ClinicalDate;
}

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
 * AG-050. Moving one appointment to another moment.
 *
 * WHAT IS NOT HERE IS THE POINT: no patient, no practitioner, no room and no
 * type of attention. The new entry is the old one moved, so all of that is
 * copied from the stored row and none of it is a decision this request may
 * take — a body that could change the patient would let «reprogramar» quietly
 * hand somebody else's hour to another person.
 */
export interface RescheduleRequest {
  siteId: string;
  entryId: string;
  startsAt: Date;
  endsAt: Date;
  /** Unvalidated: `checkBookingChannel` decides (AG-034). */
  bookingChannel: string;
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

export interface TransitionRequest {
  siteId: string;
  entryId: string;
  to: AgendaTransitionTarget;
  /**
   * Free text. Required by the DTO exactly when `to` is CANCELLED (AG-044);
   * whenever it comes it lands in the history's `note`, and on a
   * cancellation also in `cancellation_note`. Never in a log (AG-074).
   */
  reason?: string;
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

    await this.checkIntervalIsBookable({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      patientId: request.patientId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      channel: bookingChannel,
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
    now: Date;
  }): Promise<void> {
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

    // AG-012, AG-013, AG-014, AG-028 and AG-104 in one pure call. Overbooking
    // is not declarable in this delivery: it needs the authorisation column
    // the schema does not have yet (AG-035).
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
    });
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

    await this.checkIntervalIsBookable({
      siteId: request.siteId,
      practitionerId: original.practitionerId,
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
  ): Promise<AgendaEntryView> {
    const now = new Date();
    let from: AgendaEntryStatus | undefined;

    // AG-044 lives HERE, not only in the DTO (adversarial review of E2,
    // P2-3): E3 will cancel the original entry from inside the service, and
    // an internal caller must hit the same DEBERÁ the HTTP boundary enforces.
    // Before any read: a refusal that costs a transaction is a worse refusal.
    if (request.to === 'CANCELLED' && !request.reason?.trim()) {
      throw new CancellationReasonRequiredError();
    }

    const entry = await this.agenda.transition(
      {
        siteId: request.siteId,
        entryId: request.entryId,
        changedById: requester.userId,
      },
      (read) => {
        from = read.status;
        // AG-040, AG-046: the table of SPEC §5, and BLOCKED is blocks-only.
        assertTransition(read.kind, read.status, request.to);
        // AG-043: nobody is a no-show before the appointment starts.
        if (request.to === 'NO_SHOW') {
          assertNoShowNotBeforeStart(read.startsAt, now);
        }
        // AG-045: a documented attention outweighs the agenda.
        if (
          (request.to === 'CANCELLED' || request.to === 'NO_SHOW') &&
          read.hasEncounter
        ) {
          throw new AgendaEntryHasEncounterError();
        }

        return {
          to: request.to,
          effects: effectsOf(request.to, now),
          // AG-044: the reason lands on the entry only when it is annulled.
          cancellationNote:
            request.to === 'CANCELLED' ? request.reason : undefined,
          // AG-004: and in the history whenever the caller gave one.
          historyNote: request.reason,
        };
      },
    );

    /**
     * AG-074. Site, action and the two states, in stable codes. No patient,
     * no reason: "la cita pasó a otra sala" is operational, who missed which
     * doctor is health data.
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

  /** AG-108. Selector data: names, and deliberately nothing else. */
  async schedulablePractitioners(siteId: string) {
    return this.agenda.listSchedulablePractitioners(siteId);
  }
}
