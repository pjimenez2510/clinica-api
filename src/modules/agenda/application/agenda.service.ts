import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  AGENDA_REPOSITORY,
  type AgendaEntryView,
  type AgendaRepository,
} from '../domain/agenda.repository';
import { checkBookingChannel, checkBookingFitsSchedule, checkRoomBelongsToSite } from '../domain/booking-policy'; // prettier-ignore
import {
  type ClinicalDate,
  clinicalDateOf,
  clinicalDayBounds,
} from '../../../shared/domain/clinic-time';
import {
  type AvailabilityView,
  deriveAvailability,
} from '../domain/slot-availability';

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
  serviceTypeConceptId?: string;
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
   * NOT AUDITED PER ROW, for the same reason as the day's list (AG-072,
   * SC-004): nothing served here is clinical content.
   */
  async availability(request: AvailabilityRequest): Promise<AvailabilityView> {
    // AG-001. The range runs from the first midnight to the last, both read in
    // Ecuador: a range cut in UTC would drop a 20:30 appointment out of its own
    // day and then offer a slot that is already taken.
    const { startsAt } = clinicalDayBounds(request.from);
    const { endsAtExclusive } = clinicalDayBounds(request.to);

    const { practitioner, rules, entries } =
      await this.agenda.availabilityContextFor({
        practitionerId: request.practitionerId,
        siteId: request.siteId,
        fromDate: request.from,
        toDate: request.to,
        from: startsAt,
        untilExclusive: endsAtExclusive,
      });

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
      from: request.from,
      to: request.to,
    });
  }

  /**
   * AG-020, AG-029. Books an appointment.
   *
   * ORDER OF THE CHECKS, and why. The channel first because it costs nothing
   * and a typo there needs no database at all. The merged chart next, because
   * refusing at the end would mean the receptionist finds out only after the
   * schedule was read. The schedule last, since it is the one that needs the
   * rules. The overlap is never checked: it is written and arbitrated.
   */
  async book(
    request: BookAppointmentRequest,
    requester: Requester,
  ): Promise<AgendaEntryView> {
    // AG-034. Returns the channel or refuses; there is no default, because
    // AG-080 reports by channel and an invented value reports a lie.
    const bookingChannel = checkBookingChannel(request.bookingChannel);

    /**
     * AG-027. A merged chart is refused with the surviving number.
     *
     * A patient that does NOT exist is deliberately not refused here: the
     * foreign key does it, at write time, without a read that a concurrent
     * merge could invalidate. Answering "not found" from here would also make
     * the endpoint an oracle for guessed identifiers.
     */
    const patient = await this.agenda.findPatientForBooking(request.patientId);
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
    if (request.roomId !== undefined) {
      checkRoomBelongsToSite(
        await this.agenda.roomSiteOf(request.roomId),
        request.siteId,
      );
    }

    // The weekly rules are wall clock, so they are read for the ECUADORIAN
    // date of the requested start: read in UTC, a 20:00 appointment would be
    // matched against the next day's rules.
    const { practitioner, rules } = await this.agenda.scheduleContextFor({
      practitionerId: request.practitionerId,
      siteId: request.siteId,
      date: clinicalDateOf(request.startsAt),
    });

    // AG-012, AG-013, AG-014, AG-028 and AG-104 in one pure call. Overbooking
    // is not declarable in this delivery: it needs the authorisation column
    // the schema does not have yet (AG-035).
    checkBookingFitsSchedule({
      request: {
        practitionerId: request.practitionerId,
        siteId: request.siteId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
      },
      rules,
      practitioner: practitioner ?? {
        practitionerId: request.practitionerId,
        schedulable: false,
        siteIds: [],
      },
    });

    const entry = await this.agenda.book({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      patientId: request.patientId,
      roomId: request.roomId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      bookingChannel,
      serviceTypeConceptId: request.serviceTypeConceptId,
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

    return entry;
  }
}
