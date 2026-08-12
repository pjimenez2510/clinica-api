import {
  Body,
  Controller,
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
import type { AvailabilityView } from './domain/slot-availability';
import {
  AgendaEntryDto,
  AvailabilityDto,
  AvailabilityQueryDto,
  BookAppointmentDto,
  DailyAgendaDto,
  DailyAgendaQueryDto,
  type AgendaEntryResponse,
  type AvailabilityResponse,
  type DailyAgendaResponse,
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
   * AG-003, AG-010, AG-011, AG-013, AG-014. What is free and what is taken.
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

  /** AG-020, AG-029. Books an appointment into this site's agenda. */
  @Post('entries')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reservar una cita' })
  @ApiCreatedResponse({ type: AgendaEntryDto })
  async book(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: BookAppointmentDto,
  ): Promise<AgendaEntryResponse> {
    const entry = await this.agenda.book(
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
        serviceTypeConceptId: dto.serviceTypeConceptId,
        reason: dto.reason,
      },
      // AG-029: who booked it. From the session, never from the body — a
      // client must not be able to name somebody else as the author.
      { userId: this.currentUser.requireUserId() },
    );

    return toEntryResponse(entry);
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
    startsAt: entry.startsAt.toISOString(),
    endsAt: entry.endsAt.toISOString(),
    status: entry.status,
    blocksCalendar: entry.blocksCalendar,
    // AG-018: what tells a released entry apart from a live one.
    releasedAt: entry.releasedAt?.toISOString() ?? null,
    bookingChannel: entry.bookingChannel,
    serviceTypeConceptId: entry.serviceTypeConceptId,
    createdById: entry.createdById,
  };
}
