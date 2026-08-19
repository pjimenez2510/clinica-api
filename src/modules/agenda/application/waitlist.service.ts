import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  CLINIC_TIME_ZONE,
  type ClinicalDate,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  AgendaEntryNotFoundError,
  ReleasedSlotInThePastError,
  SlotNotReleasedError,
  WaitlistEntryClosedError,
  WaitlistEntryNotFoundError,
} from '../domain/agenda.errors';
import {
  AGENDA_REPOSITORY,
  type AgendaEntryView,
  type AgendaRepository,
} from '../domain/agenda.repository';
import {
  type FreedSlot,
  type RankedCandidate,
  type WaitlistContactOutcome,
  entriesToExpire,
  hasSlotPassed,
  isOpenWaitlistStatus,
  rankCandidates,
  rankWaiting,
  resolveWaitlistParameters,
  statusAfterContact,
} from '../domain/waitlist';
import {
  WAITLIST_REPOSITORY,
  type WaitlistEntryView,
  type WaitlistRepository,
} from '../domain/waitlist.repository';

import type { Requester } from './agenda.service';

export interface EnrolRequest {
  siteId: string;
  patientId: string;
  preferredFrom: ClinicalDate;
  preferredTo: ClinicalDate;
  practitionerId?: string;
  /**
   * AG-060. The clinic's own `service_type`, which is what
   * `agenda_entry.service_type_id` names since C4 and what this column names
   * since `waitlist_service_type_follows_agenda`. Absent means ANY type, so
   * the entry is a wider match rather than a narrower one.
   */
  serviceTypeId?: string;
}

export interface WaitlistReviewRequest {
  siteId: string;
}

export interface CandidatesRequest {
  siteId: string;
  /** The entry whose slot came free (AG-061). */
  entryId: string;
}

export interface CandidatesResult {
  /** The interval the candidates are being offered, as the entry states it. */
  slot: FreedSlot & { startsAt: Date; endsAt: Date };
  candidates: readonly RankedCandidate[];
}

export interface ContactRequest {
  siteId: string;
  entryId: string;
  outcome: WaitlistContactOutcome;
}

export interface ConversionRequest {
  siteId: string;
  entryId: string;
  /** The appointment already booked for this patient (AG-063). */
  appointmentId: string;
}

/**
 * The waiting list: enrolling, proposing, calling and converting.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, BECAUSE IT IS ANOTHER AGGREGATE (ADR-008 §2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It shares no method with `AgendaService`, it is written by a different
 * person at a different moment, and it changes for different reasons — D-040
 * can move what «agotar los intentos» means without touching a rule about
 * overlapping appointments. It does READ the agenda through
 * `AgendaRepository`, for two facts that live there and nowhere else: which
 * interval came free, and whether the appointment being linked is this
 * patient's.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AG-065 AND AG-066 ARE ACTS, AND THIS IS WHERE THEY HAPPEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing HAPPENS when a preferred date passes: the clock moves and the
 * database is not told, so no constraint can mark the row. The sweep therefore
 * runs at the head of every use case that could otherwise act on a lapsed
 * entry — proposing, reviewing, calling — before it does anything else.
 *
 * WHY NOT A SCHEDULED JOB: because it is the answer that depends on somebody
 * remembering, and a missed run means an entry whose fortnight ended in July
 * still competing for October's slots with its original seniority, with
 * nothing red anywhere. Doing it where the state is read cannot be forgotten:
 * the only way to observe the difference is to perform the read that fixes it.
 * AG-066 is the other half and it is an EVENT — the attempt that reaches the
 * cap — so it is applied on the spot, in the same transaction as the attempt.
 *
 * IT IS IDEMPOTENT AND CONVERGENT. Asking twice writes nothing the second
 * time and answers the same, so the read stays a read from the caller's side.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @Inject(WAITLIST_REPOSITORY)
    private readonly waitlist: WaitlistRepository,
    @Inject(AGENDA_REPOSITORY)
    private readonly agenda: AgendaRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WaitlistService.name);
  }

  /**
   * AG-060. Enrols a patient who could not be given a slot.
   *
   * THE ABSENCE OF A FREE SLOT IS NOT VERIFIED, and that is deliberate:
   * «CUANDO no haya cupo disponible en el rango solicitado» describes the
   * situation that brings somebody to the counter, not a condition a server
   * can check. A slot free this second is taken the next, and the patient may
   * be turning one down for reasons the grid knows nothing about; refusing the
   * enrolment because the system found one would refuse the cases that matter.
   *
   * WHAT IS CHECKED is the chart: a merged one cannot be booked (AG-027), so
   * enrolling it would put somebody in a queue whose slot could never be given
   * to them. The answer names the surviving MRN, exactly as booking does.
   *
   * NO AUTHOR IS RECORDED, because there is no column for one and inventing it
   * was not this tranche's business: what AG-064 makes accountable is the CALL
   * — who phoned, when, and what the patient said — and that is
   * `waitlist_contact_attempt`, which does carry its author and cannot be
   * rewritten.
   */
  async enrol(request: EnrolRequest): Promise<WaitlistEntryView> {
    const patient = await this.agenda.findPatientForBooking(request.patientId);

    // `null` means no such chart: the insert then fails on the foreign key,
    // which is the same answer booking gives and says nothing about who exists.
    if (patient !== null && patient.mergedIntoMrn !== null) {
      throw new PatientMergedError(patient.mergedIntoMrn);
    }

    const entry = await this.waitlist.enrolInWaitlist({
      siteId: request.siteId,
      patientId: request.patientId,
      preferredFrom: request.preferredFrom,
      preferredTo: request.preferredTo,
      practitionerId: request.practitionerId ?? null,
      serviceTypeId: request.serviceTypeId ?? null,
    });

    // AG-074. The site and the fact. No chart identifier, no dates, no name.
    this.logger.info(
      { site_id: entry.siteId, action: 'WAITLIST_ENROLLED' },
      'patient enrolled in the waiting list',
    );

    return entry;
  }

  /**
   * AG-065, AG-066, AG-067. The entries of a site that are still waiting.
   *
   * The sweep runs first, so what comes back is what the requirements say is
   * open — never a row that says `WAITING` because nobody has looked at it
   * since its last preferred day.
   */
  async review(
    request: WaitlistReviewRequest,
  ): Promise<readonly RankedCandidate[]> {
    const today = this.todayIn(this.now());
    await this.sweep(request.siteId, today);

    return rankWaiting(
      await this.waitlist.openWaitlistEntriesFor(request.siteId),
      today,
    );
  }

  /**
   * AG-061. Who is offered the slot that just came free, in order.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A QUERY ABOUT A RELEASED ENTRY, NOT AN AUTOMATIC EFFECT — and why
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «Proponer» needs somebody to propose to. This system has no channel to
   * push a proposal into — the reminders by WhatsApp are Phase 4 and the
   * patient portal is Phase 3 (SPEC, alcance) — so an effect fired inside
   * `transition` would compute a list and drop it on the floor, and the list
   * would be stale by the time a receptionist got to it.
   *
   * AND A SLOT COMES FREE IN MORE THAN ONE WAY: an appointment cancelled
   * (AG-041), one marked as a no-show (AG-042), the original half of a
   * reschedule (AG-050), a block undone (AG-114). All four stamp `released_at`
   * on a row that was occupying the calendar, and all four reach this one
   * route by naming that row. Hooking each write path would have been four
   * copies of «qué es un cupo liberado», and the fifth path would have been
   * written without one.
   *
   * THE ENTRY IS THE ADDRESS, NOT AN INTERVAL IN THE QUERY STRING. The server
   * derives the day, the practitioner and the type of attention from the row
   * that was released, so a client cannot ask about an interval that never
   * came free — and the precondition of the requirement, «un cupo QUE OCUPABA
   * CALENDARIO», is enforced instead of assumed (`SLOT_NOT_RELEASED`).
   *
   * AND THE SLOT HAS TO STILL BE THERE. A cancelled appointment does not stop
   * being released when its hour goes by, so nothing in the row says the
   * offer is over — the clock does, and it is read here
   * (`RELEASED_SLOT_IN_THE_PAST`). Without it this route led reception by the
   * hand to a wall: it proposed, somebody phoned a real person, they accepted,
   * and booking refused the hour (AG-031) — after spending one of the attempts
   * that entry has before it expires (AG-066), on an append-only trail.
   */
  async proposeCandidates(
    request: CandidatesRequest,
  ): Promise<CandidatesResult> {
    const released = await this.agenda.findEntry({
      siteId: request.siteId,
      entryId: request.entryId,
    });

    // AG-071: an entry of another site answers exactly like a missing one.
    if (released === null) throw new AgendaEntryNotFoundError();

    // AG-061: «un cupo que OCUPABA CALENDARIO». An overbooking never occupied
    // one (`blocks_calendar = false`), so releasing it frees nothing; an entry
    // still standing has not been freed at all.
    if (!released.blocksCalendar || released.releasedAt === null) {
      throw new SlotNotReleasedError();
    }

    // ONE READING OF THE CLOCK for the whole use case, and both questions are
    // asked of it: whether the hour has gone, and which Ecuadorian day it is
    // for the sweep. Two `new Date()` calls could straddle midnight in
    // Guayaquil and answer about two different days.
    const now = this.now();

    // AG-061, AFTER the two above: naming an entry that never came free is a
    // different mistake with a different way out —name the one that was
    // released— and it is true whatever the clock says.
    if (hasSlotPassed(released.startsAt, now)) {
      throw new ReleasedSlotInThePastError();
    }

    const today = this.todayIn(now);
    await this.sweep(request.siteId, today);

    const open = await this.waitlist.openWaitlistEntriesFor(request.siteId);
    const slot = this.slotOf(released);

    return { slot, candidates: rankCandidates(open, slot, today) };
  }

  /**
   * AG-064. Writes down one call: when, who made it, and what came of it.
   *
   * AND WHAT THE ENTRY BECOMES, in the same transaction. An attempt recorded
   * without the status that follows from it leaves an entry that has used up
   * the site's calls still competing for slots (AG-066), and the trail is
   * append-only, so the write cannot be taken back and corrected.
   *
   * IT NAMES NO SLOT, so the hole AG-061 had cannot exist here: the request
   * carries an entry and an outcome and nothing else. What kept a receptionist
   * from spending a call on an hour that had passed was never a check on this
   * route — the call is only made because the queue proposed somebody, and
   * that is where the slot is now refused.
   *
   * AN ACCEPTANCE CLOSES NOTHING HERE, and that is the second half of AG-064:
   * it is the CONFIRMATION that authorises converting the entry, and the entry
   * becomes `SCHEDULED` only when the appointment exists and is linked. A
   * decline closes nothing either — D-040 (b) is open, and nothing in AG-060
   * to AG-067 closes an entry because the patient turned one slot down.
   */
  async recordContact(
    request: ContactRequest,
    requester: Requester,
  ): Promise<WaitlistEntryView> {
    const today = this.todayIn(this.now());
    await this.sweep(request.siteId, today);

    const entry = await this.requireEntry(request.siteId, request.entryId);

    // AG-067. Includes the entry the sweep above has just expired, which is
    // exactly right: calling somebody whose entry closed this second would be
    // adding an attempt to a queue they are no longer in.
    if (!isOpenWaitlistStatus(entry.status))
      throw new WaitlistEntryClosedError();

    const parameters = resolveWaitlistParameters(
      await this.waitlist.waitlistParametersFor(request.siteId),
    );

    const updated = await this.waitlist.recordWaitlistContact({
      entryId: entry.id,
      outcome: request.outcome,
      // AG-064: who called comes from the session, never from the body. A
      // trail whose author a client picks proves nothing.
      recordedById: requester.userId,
      status: statusAfterContact(entry.contactAttempts + 1, parameters),
    });

    // AG-074. The site, the fact and the outcome — never the chart or who
    // was called.
    this.logger.info(
      {
        site_id: request.siteId,
        action: 'WAITLIST_CONTACT_RECORDED',
        outcome: request.outcome,
      },
      'waiting list contact attempt recorded',
    );

    return updated;
  }

  /**
   * AG-063. Marks the entry `SCHEDULED` and links it to the appointment.
   *
   * THE APPOINTMENT IS BOOKED FIRST, THROUGH THE ORDINARY ROUTE, and that is
   * the design rather than a shortcut. AG-063 states what happens to the ENTRY
   * — «marcarla SCHEDULED y enlazarla con la cita creada» — and says nothing
   * about how the appointment is created. Booking it here would be a second
   * path through AG-020 to AG-034: the site's window, the alignment to the
   * grid, the merged chart, the three `EXCLUDE` constraints and the
   * overbooking rules, all of which already have exactly one implementation.
   *
   * ⚠️ AND THAT IS ALSO WHY IT DOES NOT REPEAT THE CHECK AG-061 NOW MAKES.
   * Converting books nothing: the appointment already exists, and the only way
   * it can exist is the ordinary route, where `checkBookingWindow` already
   * applied AG-031 with the site's `allow_past_booking`. Adding a second
   * «no está en el pasado» here would be a weaker copy of that rule in the one
   * place it must NOT hold — a site that records attentions after the fact has
   * a legitimate past appointment to link, and this method would refuse to
   * close the entry that was actually served.
   *
   * WHAT THE DATABASE ARBITRATES AND THIS METHOD ONLY TRANSLATES: that the
   * appointment is of the SAME chart (AG-063), that an acceptance is on record
   * (AG-064), that the entry is not already closed (AG-067) and that no other
   * entry has claimed that slot. The adapter turns each refusal into a
   * sentence somebody at the desk can act on.
   */
  async convert(request: ConversionRequest): Promise<WaitlistEntryView> {
    const entry = await this.requireEntry(request.siteId, request.entryId);

    if (!isOpenWaitlistStatus(entry.status))
      throw new WaitlistEntryClosedError();

    // AG-071. The appointment has to be of THIS site, and an unknown one
    // answers like an entry of somebody else's site: the same 404, so probing
    // identifiers confirms nothing.
    const appointment = await this.agenda.findEntry({
      siteId: request.siteId,
      entryId: request.appointmentId,
    });
    if (appointment === null) throw new AgendaEntryNotFoundError();

    const converted = await this.waitlist.convertWaitlistEntry({
      entryId: entry.id,
      appointmentId: appointment.id,
    });

    // AG-074. The site and the fact; neither chart travels.
    this.logger.info(
      { site_id: request.siteId, action: 'WAITLIST_CONVERTED' },
      'waiting list entry converted into an appointment',
    );

    return converted;
  }

  /**
   * AG-065, AG-066. Closes what the domain says has lapsed, for one site.
   *
   * SCOPED TO THE SITE, like every route of this module (AG-071), which is
   * also what keeps it cheap: a site's open waiting list is counted in tens.
   */
  private async sweep(siteId: string, today: ClinicalDate): Promise<void> {
    const [open, stored] = await Promise.all([
      this.waitlist.openWaitlistEntriesFor(siteId),
      this.waitlist.waitlistParametersFor(siteId),
    ]);

    const lapsed = entriesToExpire(
      open,
      today,
      resolveWaitlistParameters(stored),
    );
    if (lapsed.length === 0) return;

    const closed = await this.waitlist.expireWaitlistEntries(lapsed);

    // AG-074. How many, never who.
    this.logger.info(
      { site_id: siteId, action: 'WAITLIST_ENTRIES_EXPIRED', count: closed },
      'waiting list entries expired',
    );
  }

  private async requireEntry(
    siteId: string,
    entryId: string,
  ): Promise<WaitlistEntryView> {
    const entry = await this.waitlist.findWaitlistEntry({ siteId, entryId });
    if (entry === null) throw new WaitlistEntryNotFoundError();
    return entry;
  }

  /**
   * The freed interval, as AG-061 compares it.
   *
   * THE DAY IS RESOLVED IN ECUADOR, never in the session's zone: an
   * appointment at 20:30 would otherwise fall on the following day and be
   * offered to whoever asked for that one instead (AG-001).
   */
  private slotOf(
    released: AgendaEntryView,
  ): FreedSlot & { startsAt: Date; endsAt: Date } {
    return {
      date: clinicalDateOf(released.startsAt, CLINIC_TIME_ZONE),
      practitionerId: released.practitionerId,
      // A released BLOCK fixes no type of attention, and an entry that demands
      // one is simply not satisfied by it.
      serviceTypeId: released.serviceTypeId,
      startsAt: released.startsAt,
      endsAt: released.endsAt,
    };
  }

  /**
   * The current instant. The only place this service reads a clock, and the
   * reason the domain never has to: every rule down there takes it as a
   * parameter.
   */
  private now(): Date {
    return new Date();
  }

  /**
   * The day that instant falls on IN ECUADOR, never in the session's zone
   * (AG-001). At 20:00 in Guayaquil the UTC date is already tomorrow, and an
   * entry whose last preferred day is today would be expired half a shift
   * early (AG-065).
   */
  private todayIn(now: Date): ClinicalDate {
    return clinicalDateOf(now, CLINIC_TIME_ZONE);
  }
}
