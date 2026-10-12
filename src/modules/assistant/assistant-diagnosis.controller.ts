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
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  DiagnosisProposalService,
  type DiagnosisOverview,
  type ProposalRequester,
} from './application/diagnosis-proposal.service';
import { assistantRequester } from './assistant-requester';
import {
  AcceptDiagnosisProposalDto,
  DiagnosisOverviewDto,
  DiagnosisReadingDto,
} from './dto/diagnosis-proposal.dto';

/** AS-026. Whether `ASSISTANT_ENABLED` is on, read once at boot. */
export const ASSISTANT_ENABLED = Symbol('ASSISTANT_ENABLED');

/**
 * AS-026 to AS-044. The CIE-10 the assistant proposes in Diagnósticos.
 *
 * `assistant:use` on every route, with `'query'` scope like the encounter's
 * routes: the attention is addressed by its id and the site is not in the
 * URL, so the service narrows with the caller's own `record:read` or
 * `record:write` sites (EN-121). `assistant:use` alone opens nothing of the
 * history.
 *
 * AS-026. Without `ASSISTANT_ENABLED` every route answers 404, the same
 * answer a route that does not exist gets, so a screen in an installation
 * that did not turn it on shows nothing of it.
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/diagnoses', version: '1' }) // prettier-ignore
export class AssistantDiagnosisController {
  constructor(
    private readonly proposals: DiagnosisProposalService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  /** AS-027, AS-036. The baseline and the proposals of the latest reading. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'CIE-10 propuesto para la atención' })
  @ApiOkResponse({ type: DiagnosisOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<DiagnosisOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.overview(encounterId, this.requester(req)),
    );
  }

  /** AS-028, AS-035, AS-036, AS-040. «Proponer por problema». */
  @Post('read')
  @RequirePermission('assistant:use', 'query')
  // AS-040. Each reading pays one call per problem: six a minute is a
  // physician asking again, not a loop draining the month's ceiling.
  @Throttle({ long: { ttl: 60_000, limit: 6 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Proponer el CIE-10 por problema leyendo la nota' })
  @ApiOkResponse({ type: DiagnosisReadingDto })
  async read(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<DiagnosisReadingDto> {
    this.requireEnabled();
    const reading = await this.proposals.read(encounterId, this.requester(req));
    return {
      ...toResponse(reading),
      found: reading.found,
      dropped: reading.dropped,
    };
  }

  /** AS-037. Links the proposal to the diagnosis recorded from it. */
  @Post(':suggestionId/accept')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar una propuesta con el diagnóstico registrado' }) // prettier-ignore
  @ApiOkResponse({ type: DiagnosisOverviewDto })
  async accept(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Body() dto: AcceptDiagnosisProposalDto,
    @Req() req: Request,
  ): Promise<DiagnosisOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.accept(
        { encounterId, suggestionId, diagnosisId: dto.diagnosisId },
        this.requester(req),
      ),
    );
  }

  /** AS-038. Discards a proposal. */
  @Post(':suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una propuesta del asistente' })
  @ApiOkResponse({ type: DiagnosisOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<DiagnosisOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.discard(
        { encounterId, suggestionId },
        this.requester(req),
      ),
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private requester(req: Request): ProposalRequester {
    return assistantRequester(this.currentUser, req);
  }
}

/** Instants leave as ISO 8601. */
function toResponse(overview: DiagnosisOverview): DiagnosisOverviewDto {
  return {
    ...overview,
    readAt: overview.readAt?.toISOString() ?? null,
  };
}
