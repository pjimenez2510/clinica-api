import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { WaitlistService } from './application/waitlist.service';
import type { RankedCandidate } from './domain/waitlist';
import {
  ConvertWaitlistEntryDto,
  EnrolInWaitlistDto,
  RecordContactAttemptDto,
  WaitlistCandidateDto,
  WaitlistCandidatesDto,
  WaitlistDto,
  WaitlistEntryDto,
  type WaitlistCandidatesResponse,
  type WaitlistEntryResponse,
  type WaitlistResponse,
} from './dto/agenda.dto';
import type { WaitlistEntryView } from './domain/waitlist.repository';

/**
 * The waiting list of one site (E5, AG-060 to AG-067).
 *
 * A CONTROLLER OF ITS OWN, under the same site prefix as the agenda's. It
 * serves a different aggregate — enrolling, calling, converting — and putting
 * it beside `book` and `reschedule` would have made one class answer for two
 * things that share no rule.
 *
 * EVERY ROUTE DECLARES ITS PERMISSION AND IS SITE-SCOPED THROUGH
 * `param:siteId` (AG-070, AG-071), for the same reason as `AgendaController`:
 * guards run before pipes, so the site can only be checked by the guard when
 * it is in the path. A receptionist hired at Norte has no business in Sur's
 * waiting list.
 *
 * ⚠️ `agenda:read` / `agenda:write` AND NOT A PERMISSION OF THEIR OWN.
 * Enrolling somebody who could not be given a slot is the same act as booking
 * one, done by the same person at the same desk in the same conversation, and
 * inventing `waitlist:write` would mean a permission no role carries and a
 * screen nobody can reach (the argument `POST blocks` already settled).
 *
 * ⚠️ WHAT NEVER TRAVELS FROM HERE: the reason for the visit, the patient's
 * name, and — above all — WHY somebody is a priority. `priority` is `1` or `2`
 * and is derived from periods the query never names by group, so the motive
 * cannot leak through a listing even by mistake (PA-042, AG-073, AG-074).
 */
@ApiTags('agenda')
@Controller({ path: 'agenda/sites/:siteId/waitlist', version: '1' })
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * AG-062, AG-065, AG-066, AG-067. Who is waiting at this site, in order.
   *
   * IT SWEEPS BEFORE IT ANSWERS, and that is where AG-065 happens: nothing
   * occurs when a preferred date passes — the clock moves and the database is
   * not told — so the entries that lapsed are marked `EXPIRED` before anybody
   * can read them as waiting. Asking twice writes nothing the second time and
   * answers the same.
   *
   * NOT AUDITED PER ROW (AG-072, SC-004), like the day's agenda: what it
   * carries are identifiers and dates, never clinical content.
   */
  @Get()
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar la lista de espera de una sede' })
  @ApiOkResponse({ type: WaitlistDto })
  async waiting(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<WaitlistResponse> {
    const items = await this.waitlist.review({ siteId });

    return { siteId, items: items.map(toCandidateResponse) };
  }

  /**
   * AG-060. Enrols a patient for whom there was no slot.
   *
   * 201 WITH THE ENTRY: the screen paints the new row without a second call,
   * and the identifier is what every later act — calling, converting — names.
   */
  @Post()
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Inscribir a un paciente en la lista de espera' })
  @ApiCreatedResponse({ type: WaitlistEntryDto })
  async enrol(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: EnrolInWaitlistDto,
  ): Promise<WaitlistEntryResponse> {
    const entry = await this.waitlist.enrol({
      siteId,
      patientId: dto.patientId,
      preferredFrom: dto.preferredFrom,
      preferredTo: dto.preferredTo,
      practitionerId: dto.practitionerId,
      // AG-060. Omitirlo significa «cualquiera», y desde
      // `waitlist_service_type_follows_agenda` fijarlo significa algo: es la
      // misma tabla que nombra la cita, así que AG-061 puede compararlos.
      serviceTypeId: dto.serviceTypeId,
    });

    return toEntryResponse(entry);
  }

  /**
   * AG-061. The candidates for a slot that has just come free.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY IT HANGS OFF THE RELEASED ENTRY AND IS NOT AN AUTOMATIC EFFECT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «Proponer» needs somebody to propose TO, and this system has no channel to
   * push into: the portal is Phase 3 and the reminders Phase 4. An effect
   * fired inside the cancellation would compute a list, drop it on the floor,
   * and be stale by the time a receptionist looked.
   *
   * A slot also comes free in four different ways — an appointment cancelled
   * (AG-041), one marked as a no-show (AG-042), the original half of a
   * reschedule (AG-050), a block undone (AG-114) — and all four stamp
   * `released_at` on a row that was occupying the calendar. Naming that ROW is
   * what makes one route serve all four, present and future, instead of four
   * copies of «qué es un cupo liberado» and a fifth path written without one.
   *
   * AND THE SERVER DERIVES THE SLOT from the released row: the day, the
   * practitioner and the type of attention are not query parameters, so a
   * client cannot ask about an interval that never came free — and an entry
   * that is still standing is refused with `SLOT_NOT_RELEASED` rather than
   * quietly answered.
   */
  @Get('candidates/:releasedEntryId')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({
    summary: 'Proponer candidatos de la lista de espera para un cupo liberado',
  })
  @ApiOkResponse({ type: WaitlistCandidatesDto })
  async candidates(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('releasedEntryId', ParseUUIDPipe) releasedEntryId: string,
  ): Promise<WaitlistCandidatesResponse> {
    const proposal = await this.waitlist.proposeCandidates({
      siteId,
      entryId: releasedEntryId,
    });

    return {
      siteId,
      releasedEntryId,
      slot: {
        date: proposal.slot.date,
        startsAt: proposal.slot.startsAt.toISOString(),
        endsAt: proposal.slot.endsAt.toISOString(),
        practitionerId: proposal.slot.practitionerId,
        serviceTypeId: proposal.slot.serviceTypeId,
      },
      items: proposal.candidates.map(toCandidateResponse),
    };
  }

  /**
   * AG-064. Writes down one call: when, who made it, and what came of it.
   *
   * POST AND NOT PATCH, because it is not an edit: it appends to a trail the
   * database refuses to let anyone rewrite, and it may close the entry when
   * the site's attempts run out (AG-066). 200 with the updated entry, so the
   * screen repaints without asking again.
   *
   * THE AUTHOR IS NOT IN THE BODY. It comes from the session: «se le llamó
   * tres veces» signed by whoever the client felt like naming proves nothing.
   */
  @Post(':entryId/contact-attempts')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar un intento de contacto' })
  @ApiOkResponse({ type: WaitlistEntryDto })
  async recordContact(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: RecordContactAttemptDto,
  ): Promise<WaitlistEntryResponse> {
    const entry = await this.waitlist.recordContact(
      { siteId, entryId, outcome: dto.outcome },
      { userId: this.currentUser.requireUserId() },
    );

    return toEntryResponse(entry);
  }

  /**
   * AG-063. Closes the entry against the appointment the patient accepted.
   *
   * THE APPOINTMENT IS BOOKED FIRST, through `POST agenda/sites/:siteId/entries`
   * like any other: AG-063 states what happens to the ENTRY and says nothing
   * about how the appointment is created, and booking it here would be a
   * second path through the site's window, the grid alignment, the merged
   * chart and the three `EXCLUDE` constraints.
   *
   * IT IS REFUSED WITHOUT A RECORDED ACCEPTANCE, and the database is what
   * refuses it (AG-064): the answer names the attempt that has to be recorded
   * first, in place of a constraint name.
   */
  @Post(':entryId/conversion')
  @RequirePermission('agenda:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Convertir una inscripción en la cita reservada' })
  @ApiOkResponse({ type: WaitlistEntryDto })
  async convert(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: ConvertWaitlistEntryDto,
  ): Promise<WaitlistEntryResponse> {
    const entry = await this.waitlist.convert({
      siteId,
      entryId,
      appointmentId: dto.appointmentId,
    });

    return toEntryResponse(entry);
  }
}

/** Instants leave as ISO 8601; the calendar days leave as they are stored. */
function toEntryResponse(entry: WaitlistEntryView): WaitlistEntryResponse {
  return {
    id: entry.id,
    siteId: entry.siteId,
    patientId: entry.patientId,
    practitionerId: entry.practitionerId,
    serviceTypeId: entry.serviceTypeId,
    preferredFrom: entry.preferredFrom,
    preferredTo: entry.preferredTo,
    status: entry.status,
    convertedEntryId: entry.convertedEntryId,
    contactAttempts: entry.contactAttempts,
    lastContactedAt: entry.lastContactedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * A candidate as the screen paints it.
 *
 * `priority` and NOTHING that says why (PA-042, AG-073). There is no group
 * code to leave out: the query that produced this never selected one.
 */
function toCandidateResponse(candidate: RankedCandidate): WaitlistCandidateDto {
  return {
    entryId: candidate.entryId,
    patientId: candidate.patientId,
    priority: candidate.priority,
    status: candidate.status,
    enrolledAt: candidate.enrolledAt.toISOString(),
    practitionerId: candidate.practitionerId,
    serviceTypeId: candidate.serviceTypeId,
    preferredFrom: candidate.preferredFrom,
    preferredTo: candidate.preferredTo,
    contactAttempts: candidate.contactAttempts,
    lastContactedAt: candidate.lastContactedAt?.toISOString() ?? null,
  };
}
