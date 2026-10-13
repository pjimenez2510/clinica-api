import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  type DraftOverview,
  type DraftRequester,
  NoteDraftService,
} from './application/note-draft.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { withAssistant } from './assistant-sites';
import {
  AcceptDraftSectionDto,
  NoteDraftOverviewDto,
} from './dto/note-draft.dto';

/**
 * AS-086 to AS-097. The draft of the note in the Nota tab.
 *
 * `assistant:use` with `'query'` scope, like the diagnoses: the service
 * narrows with the caller's own `record:write` sites crossed with the
 * assistant's, and only the attention's professional gets an answer (AS-039).
 * Without `ASSISTANT_ENABLED`, a 404 before anything else (AS-026).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/note-draft', version: '1' }) // prettier-ignore
export class AssistantNoteDraftController {
  constructor(
    private readonly drafts: NoteDraftService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  /** AS-096. The latest draft and its sections. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Borrador de la nota propuesto por el asistente' })
  @ApiOkResponse({ type: NoteDraftOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<NoteDraftOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.drafts.overview(encounterId, this.requester(req))); // prettier-ignore
  }

  /** AS-086. «Pedir borrador» and «Volver a pedir»: 202, it is written apart. */
  @Post()
  @RequirePermission('assistant:use', 'query')
  // A draft pays a call: twelve a minute is a physician asking again, not a
  // loop draining the month's ceiling. The listening asks on its own.
  @Throttle({ long: { ttl: 60_000, limit: 12 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Pedir el borrador de la nota con lo transcrito' })
  @ApiAcceptedResponse({ type: NoteDraftOverviewDto })
  async request(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<NoteDraftOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.drafts.request(encounterId, this.requester(req))); // prettier-ignore
  }

  /** AS-147. «Dejar de esperar»: cancels the draft queued or being written. */
  @Post('cancel')
  @RequirePermission('assistant:use', 'query')
  // Each one writes the trail: a physician changing their mind, not a loop.
  @Throttle({ long: { ttl: 60_000, limit: 12 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dejar de esperar el borrador en curso' })
  @ApiOkResponse({ type: NoteDraftOverviewDto })
  async cancel(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<NoteDraftOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.drafts.stopWaiting(encounterId, this.requester(req))); // prettier-ignore
  }

  /** AS-094. Links a section to the note it was saved into. Never signs. */
  @Post('sections/:suggestionId/accept')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar una sección del borrador guardada en la nota' }) // prettier-ignore
  @ApiOkResponse({ type: NoteDraftOverviewDto })
  async accept(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Body() dto: AcceptDraftSectionDto,
    @Req() req: Request,
  ): Promise<NoteDraftOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.drafts.accept(
        { encounterId, suggestionId, noteId: dto.noteId },
        this.requester(req),
      ),
    );
  }

  /** AS-094. Discards a section of the draft. */
  @Post('sections/:suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una sección del borrador' })
  @ApiOkResponse({ type: NoteDraftOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<NoteDraftOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.drafts.discard({ encounterId, suggestionId }, this.requester(req)), // prettier-ignore
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private requester(req: Request): DraftRequester {
    const principal = this.currentUser.requirePrincipal();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites: withAssistant(principal, 'record:write'),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601. */
function toResponse(overview: DraftOverview): NoteDraftOverviewDto {
  return {
    ...overview,
    draft: overview.draft && {
      ...overview.draft,
      requestedAt: overview.draft.requestedAt.toISOString(),
      finishedAt: overview.draft.finishedAt?.toISOString() ?? null,
    },
  };
}
