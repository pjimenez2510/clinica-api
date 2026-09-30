import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { AgendaService } from './application/agenda.service';
import type { AgendaEntryView } from './domain/agenda.repository';
import { arrivalDelayMinutes } from './domain/late-arrival';
import type { AvailabilityView } from './domain/slot-availability';
import {
  AgendaEntryDto,
  BlockAgendaDto,
  AvailabilityDto,
  AvailabilityQueryDto,
  BookAppointmentDto,
  BookedAppointmentDto,
  DailyAgendaDto,
  DailyAgendaQueryDto,
  DurationProposalDto,
  DurationProposalQueryDto,
  RescheduleAppointmentDto,
  RescheduledAppointmentDto,
  TransitionOutcomeDto,
  TransitionStatusDto,
  type AgendaEntryResponse,
  type AvailabilityResponse,
  type BookedAppointmentResponse,
  type TransitionOutcomeResponse,
  type DailyAgendaResponse,
  type DurationProposalResponse,
  type RescheduledAppointmentResponse,
} from './dto/agenda.dto';

/**
 * The day's agenda of a site, and booking into it.
 *
 * EVERY ROUTE DECLARES ITS PERMISSION, and every route is SITE-SCOPED through
 * `param:siteId`. That is the difference from the patient register, which is
 * `global` on purpose: a person is the same person at either site, but what
 * HAPPENS to them — appointments, encounters, invoices — belongs to the site
 * where it happens, and a receptionist hired at Norte has no business in Sur's
 * agenda (AG-071).
 *
 * WHY THE SITE IS IN THE URL AND NOT IN THE BODY. `param:siteId` is the only
 * form the guard can enforce by itself: guards run before pipes, so at that
 * moment the body is unvalidated and unusable for an authorisation decision.
 * Putting the site in the path means AG-071 is enforced by the guard for every
 * route here, present and future, instead of by each handler remembering to
 * call `assertSiteInScope`.
 */
@ApiTags('agenda')
/**
 * The site is the CONTROLLER's prefix and the resource is each route's own
 * segment, so `entries` and `availability` sit side by side under one scope
 * check. The URLs of the two existing routes are unchanged.
 */
@Controller({ path: 'agenda/sites/:siteId', version: '1' })
export class AgendaController {
  constructor(
    private readonly agenda: AgendaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * AG-017, AG-018. The agenda of one day.
   *
   * NOT AUDITED PER ROW (AG-072, SC-004): the list carries identifiers and no
   * clinical content, and one audit entry per line would bury the accesses
   * that matter. Opening a chart from here is the accountable act, and it is
   * `GET /patients/:id` that records it.
   */
  @Get('entries')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar la agenda de un día en una sede' })
  @ApiOkResponse({ type: DailyAgendaDto })
  async dailyAgenda(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: DailyAgendaQueryDto,
  ): Promise<DailyAgendaResponse> {
    const items = await this.agenda.dailyAgenda({
      siteId,
      date: query.date,
      practitionerId: query.practitionerId,
      roomId: query.roomId,
      includeReleased: query.includeReleased,
    });

    return {
      siteId,
      date: query.date,
      items: items.map(toEntryResponse),
      includeReleased: query.includeReleased,
    };
  }

  /**
   * AG-003, AG-010, AG-011, AG-013, AG-014. What is free and what is taken,
   * plus which dates the site's holidays close and why (AG-015, AG-016), and
   * which years of the range have no calendar loaded (AG-093).
   *
   * THE ROUTE READS AND NEVER WRITES: a free slot is derived from the rules
   * minus what occupies the calendar, and nothing here materialises one as a
   * row (AG-003). Two answers in one response, because a client that has to
   * ask twice paints half a day and then contradicts itself.
   *
   * NOT AUDITED PER ROW (AG-072, SC-004), like the day's list: nothing served
   * here is clinical content, and the occupied stretches say WHEN, never WHO.
   */
  @Get('availability')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({
    summary: 'Consultar los cupos disponibles de un profesional en una sede',
  })
  @ApiOkResponse({ type: AvailabilityDto })
  async availability(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponse> {
    const view = await this.agenda.availability({
      siteId,
      practitionerId: query.practitionerId,
      from: query.from,
      to: query.to,
    });

    return {
      siteId,
      practitionerId: query.practitionerId,
      from: query.from,
      to: query.to,
      ...toAvailabilityResponse(view),
    };
  }

  /**
   * SP-028, SP-023. How long an appointment of this type with this
   * practitioner should last, at this instant.
   *
   * `agenda:read` AND NOT `config:read`: what it answers is a number of
   * minutes for a booking recepción is composing, and recepción administers no
   * catalogue. The site scope is checked like every route here (AG-071).
   *
   * A GET, because it decides nothing and stores nothing — asking twice must
   * answer twice the same.
   */
  @Get('duration')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({
    summary: 'Proponer la duración de una cita según especialidad y tipo',
  })
  @ApiOkResponse({ type: DurationProposalDto })
  async duration(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: DurationProposalQueryDto,
  ): Promise<DurationProposalResponse> {
    return this.agenda.proposeDuration({
      siteId,
      practitionerId: query.practitionerId,
      // The schema refuses an instant with no offset, so `Date` reads it
      // without guessing a zone.
      startsAt: new Date(query.startsAt),
      serviceTypeId: query.serviceTypeId,
    });
  }

  /**
   * AG-020, AG-029. Books an appointment into this site's agenda.
   *
   * AG-110 RIDES IN THIS 201 AND NOT IN A 4xx. A date the site's calendar
   * closes does not refuse the booking — the clinic works many holidays — so
   * the appointment is created and the closure comes back as a warning next to
   * it. Nothing here can turn that warning into a rejection: by the time it
   * exists, the row does too.
   */
  @Post('entries')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reservar una cita' })
  @ApiCreatedResponse({ type: BookedAppointmentDto })
  async book(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: BookAppointmentDto,
  ): Promise<BookedAppointmentResponse> {
    const booked = await this.agenda.book(
      {
        siteId,
        practitionerId: dto.practitionerId,
        patientId: dto.patientId,
        roomId: dto.roomId,
        // Both instants carry their offset — the schema refuses one that does
        // not — so `Date` reads them without guessing a zone.
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        bookingChannel: dto.bookingChannel,
        serviceTypeId: dto.serviceTypeId,
        reason: dto.reason,
        /**
         * AG-035, D-005. The exception is DECLARED or it does not exist: the
         * three flat fields of the body become one object, and its absence is
         * what tells the service to judge the booking by the grid.
         *
         * The schema guarantees the two fields are there when the flag is
         * true, so the fallback is unreachable — it is written rather than
         * asserted away because an overbooking with no authoriser is precisely
         * the row `agenda_entry_overbooking_coherence` refuses, and the
         * service answers for it with a sentence instead of a constraint name.
         */
        overbooking:
          dto.overbooking === true
            ? {
                reason: dto.overbookingReason,
                authorisedById: dto.overbookingAuthorisedById ?? '',
              }
            : undefined,
      },
      // AG-029: who booked it. From the session, never from the body — a
      // client must not be able to name somebody else as the author.
      { userId: this.currentUser.requireUserId() },
    );

    return { ...toEntryResponse(booked.entry), warnings: [...booked.warnings] };
  }

  /**
   * AG-037, AG-038. Closes a stretch of a practitioner's agenda.
   *
   * `agenda:write` AND NOT A PERMISSION OF ITS OWN: blocking an hour is the
   * same power as booking it — both take a slot out of circulation — and
   * inventing `agenda:block` would mean a permission no role carries and a
   * screen nobody can reach. What DOES need its own permission is authorising
   * an overbooking (`agenda:overbook`), because that one breaks a guarantee
   * rather than using it.
   *
   * A ROUTE OF ITS OWN (`blocks`) AND NOT A `kind` ON `entries`: what it
   * accepts has no patient, no channel and no service type, and a body where
   * four fields are meaningless depending on a fifth is a body nobody can
   * validate honestly.
   */
  @Post('blocks')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bloquear un intervalo de la agenda' })
  @ApiCreatedResponse({ type: AgendaEntryDto })
  async blockAgenda(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: BlockAgendaDto,
  ): Promise<AgendaEntryResponse> {
    const entry = await this.agenda.blockAgenda(
      {
        siteId,
        practitionerId: dto.practitionerId,
        roomId: dto.roomId,
        // Both instants carry their offset — the schema refuses one that does
        // not — so `Date` reads them without guessing a zone.
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        reason: dto.reason,
      },
      // Who closed the agenda, from the session and never from the body.
      { userId: this.currentUser.requireUserId() },
    );

    return toEntryResponse(entry);
  }

  /**
   * AG-114. Undoes a block created by mistake.
   *
   * A `DELETE` THAT DOES NOT DELETE, exactly like closing a schedule rule in
   * `staff`: what it removes is the CLOSURE — `released_at` is stamped, both
   * `EXCLUDE` constraints stop seeing the row, and the hour can be booked
   * again. The row survives because it is the proof that the interval was
   * closed, and AG-005 keeps the history row that says who undid it and when.
   *
   * 200 WITH THE ENTRY AND NOT 204: the screen repaints the block as released
   * without a second call, and answering "no content" to something that leaves
   * a visible row would be a lie of shape.
   *
   * A ROUTE UNDER `blocks` AND NOT A TRANSITION TO `CANCELLED`: the six
   * targets of `POST entries/:id/status` all state something about a patient
   * (AG-021), so a block must keep being refused there — which is what AG-040
   * does through `assertTransition`.
   */
  @Delete('blocks/:entryId')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deshacer un bloqueo y liberar el intervalo' })
  @ApiOkResponse({ type: AgendaEntryDto })
  async releaseBlock(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<AgendaEntryResponse> {
    const entry = await this.agenda.releaseBlock(
      { siteId, entryId },
      // AG-114: quién lo deshizo sale de la sesión, nunca del cuerpo.
      { userId: this.currentUser.requireUserId() },
    );

    return toEntryResponse(entry);
  }

  /**
   * AG-040 to AG-045. One status transition, with its history row (AG-004).
   *
   * POST AND NOT PATCH, because it is not an edit: it is a command against a
   * machine that can refuse it, and it leaves an append-only record behind.
   * 200 with the updated entry, so the screen repaints without a second call.
   */
  @Post('entries/:entryId/status')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar el estado de una cita' })
  @ApiOkResponse({ type: TransitionOutcomeDto })
  async transition(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: TransitionStatusDto,
  ): Promise<TransitionOutcomeResponse> {
    const outcome = await this.agenda.transition(
      {
        siteId,
        entryId,
        to: dto.to,
        reason: dto.reason,
        /**
         * AG-128, AG-130, AG-131. The article-10 call and the two things that
         * hang off it.
         *
         * NO PERMISSION OF ITS OWN (AG-130): the route's `agenda:write` is the
         * one that registers the arrival, and a permission of its own would
         * mean receptionists who cannot make the call — and then art. 10 goes
         * unmet on the days that person is at the counter.
         */
        emergency: dto.emergency,
        emergencyNote: dto.emergencyNote,
        coverageCheckSkippedReason: dto.coverageCheckSkippedReason,
      },
      // AG-004: the author comes from the session, never from the body. That
      // is also who art. 10 records as having made the call.
      { userId: this.currentUser.requireUserId() },
    );

    // AG-118, AG-119: the delay is on the entry and the warning beside it.
    return { ...toEntryResponse(outcome.entry), warnings: outcome.warnings };
  }

  /**
   * AG-050, AG-051, AG-052. Moves one appointment to another moment.
   *
   * 201 AND NOT 200, because what this leaves behind is a NEW entry: the
   * original is not edited, it is annulled and released (AG-050), and the
   * appointment the patient will turn up for is a row that did not exist
   * before. Answering 200 would say "the appointment you know about changed",
   * which is exactly what the requirement forbids happening.
   *
   * A SUB-RESOURCE OF THE ENTRY (`…/entries/:entryId/reschedule`) and not a
   * POST to `entries` with an extra field: the site scope is settled by the
   * guard from `param:siteId` like every route here (AG-071), and the entry
   * being moved is part of the address rather than of the payload.
   */
  @Post('entries/:entryId/reschedule')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reprogramar una cita a otro horario' })
  @ApiCreatedResponse({ type: RescheduledAppointmentDto })
  async reschedule(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: RescheduleAppointmentDto,
  ): Promise<RescheduledAppointmentResponse> {
    const moved = await this.agenda.reschedule(
      {
        siteId,
        entryId,
        // Both instants carry their offset — the schema refuses one that does
        // not — so `Date` reads them without guessing a zone.
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        bookingChannel: dto.bookingChannel,
        // AG-115. Absent means «el mismo», and the service is where that
        // fallback lives: the transport does not invent the stored value.
        practitionerId: dto.practitionerId,
        serviceTypeId: dto.serviceTypeId,
        reason: dto.reason,
      },
      // AG-004, AG-029: the author comes from the session, never from the body.
      { userId: this.currentUser.requireUserId() },
    );

    return {
      original: toEntryResponse(moved.original),
      created: toEntryResponse(moved.created),
      warnings: [...moved.warnings],
    };
  }
}

/**
 * The derived view, reduced to what a client needs to paint the day.
 *
 * The occupied stretches carry their two instants and nothing else — no
 * patient, no reason, not even the entry's identifier (AG-074, SC-006). A hole
 * is defined by when it is not there.
 */
function toAvailabilityResponse(view: AvailabilityView) {
  return {
    slots: view.slots.map((slot) => ({
      ruleId: slot.ruleId,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      slotMinutes: slot.slotMinutes,
      serviceTypeConceptId: slot.serviceTypeConceptId,
    })),
    occupied: view.occupied.map((entry) => ({
      startsAt: entry.startsAt.toISOString(),
      endsAt: entry.endsAt.toISOString(),
    })),
    // AG-015. The date and the motive; the slots of that day are simply not
    // in `slots`, which is what "marcar los cupos como no disponibles" means
    // for an answer that never materialised a slot as a row (AG-003).
    closedDates: view.closedDates.map((closed) => ({
      date: closed.date,
      reason: closed.reason,
    })),
    // AG-093. The doubt travels with the answer, never instead of it.
    yearsWithoutCalendar: view.yearsWithoutCalendar,
  };
}

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
function toEntryResponse(entry: AgendaEntryView) {
  return {
    id: entry.id,
    kind: entry.kind,
    siteId: entry.siteId,
    practitionerId: entry.practitionerId,
    roomId: entry.roomId,
    patientId: entry.patientId,
    patientName: entry.patientName,
    startsAt: entry.startsAt.toISOString(),
    endsAt: entry.endsAt.toISOString(),
    status: entry.status,
    blocksCalendar: entry.blocksCalendar,
    // AG-036: the reason of the exception and who authorised it, on every row.
    // NOT `reason`, which is the motive for the visit and stays out (AG-072).
    overbookingReason: entry.overbookingReason,
    overbookingAuthorisedById: entry.overbookingAuthorisedById,
    // AG-018: what tells a released entry apart from a live one.
    releasedAt: entry.releasedAt?.toISOString() ?? null,
    // AG-041, AG-118. The instant, and the subtraction that is computed here
    // and stored nowhere — which is what keeps late arrival from becoming a
    // status. The sign is kept: negative means the patient came early.
    checkedInAt: entry.checkedInAt?.toISOString() ?? null,
    arrivalDelayMinutes: arrivalDelayMinutes(entry),
    // AG-121. The patient axis, separate from the appointment's.
    subjectStatus: entry.subjectStatus,
    subjectStatusAt: entry.subjectStatusAt?.toISOString() ?? null,
    // AG-128. The act, and its outcome. Never the note (AG-074).
    emergencyAssessedAt: entry.emergencyAssessedAt?.toISOString() ?? null,
    emergencyFlaggedAt: entry.emergencyFlaggedAt?.toISOString() ?? null,
    bookingChannel: entry.bookingChannel,
    serviceTypeId: entry.serviceTypeId,
    createdById: entry.createdById,
    // AG-051: both ends of the reschedule chain, so neither entry has to be
    // looked up to find out what happened to the other.
    rescheduledFromId: entry.rescheduledFromId,
    rescheduledToId: entry.rescheduledToId,
  };
}
