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
  PrescriptionProposalService,
  type PrescriptionOverview,
} from './application/prescription-proposal.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { assistantRequester } from './assistant-requester';
import {
  ConfirmedPrescriptionLinesDto,
  ConfirmPrescriptionProposalDto,
  LinkPrescriptionProposalDto,
  PrescriptionProposalOverviewDto,
  PrescriptionProposalReadingDto,
} from './dto/prescription-proposal.dto';

/** AS-076. Proposing a receta writes toward one: the prescriber's permission. */
const PRESCRIBING = ['prescription:write'] as const;

/**
 * AS-063 to AS-076. The receta the assistant proposes in Receta.
 *
 * Same door as the CIE-10 (AS-026): `assistant:use` with `'query'` scope,
 * narrowed in the service to the caller's own `record:read` / `record:write`
 * sites, and a 404 from the middleware while `ASSISTANT_ENABLED` is off.
 *
 * ⚠️ NO ROUTE HERE WRITES A RECETA. `confirm` answers the lines ready for
 * the draft and writes nothing; the draft goes through the receta's own
 * route with its checks and its `If-Match` (PR-100, PR-121), and `link` only
 * records which line came from which proposal (P1, AS-073, AS-074).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/prescription', version: '1' }) // prettier-ignore
export class AssistantPrescriptionController {
  constructor(
    private readonly proposals: PrescriptionProposalService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  /** AS-069, AS-072. The lines of the latest reading, checked now. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Receta propuesta por el asistente' })
  @ApiOkResponse({ type: PrescriptionProposalOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<PrescriptionProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.overview(encounterId, assistantRequester(this.currentUser, req, PRESCRIBING)), // prettier-ignore
    );
  }

  /** AS-063 to AS-070, AS-077. «Proponer la receta». */
  @Post('read')
  @RequirePermission('assistant:use', 'query')
  // AS-077. Two calls a reading: six a minute is asking again, not a loop.
  @Throttle({ long: { ttl: 60_000, limit: 6 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Proponer la receta leyendo la nota' })
  @ApiOkResponse({ type: PrescriptionProposalReadingDto })
  async read(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<PrescriptionProposalReadingDto> {
    this.requireEnabled();
    const reading = await this.proposals.read(encounterId, assistantRequester(this.currentUser, req, PRESCRIBING)); // prettier-ignore
    return {
      ...toResponse(reading),
      found: reading.found,
      dropped: reading.dropped,
    };
  }

  /** AS-073. The accepted lines, checked again, ready for the draft. Writes nothing. */
  @Post('confirm')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Comprobar las líneas aceptadas para el borrador' })
  @ApiOkResponse({ type: ConfirmedPrescriptionLinesDto })
  async confirm(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: ConfirmPrescriptionProposalDto,
    @Req() req: Request,
  ): Promise<ConfirmedPrescriptionLinesDto> {
    this.requireEnabled();
    const items = await this.proposals.confirm(
      { encounterId, suggestionIds: dto.suggestionIds },
      assistantRequester(this.currentUser, req, PRESCRIBING),
    );
    return { items };
  }

  /** AS-074. Links the proposals to the lines of the draft saved from them. */
  @Post('link')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enlazar las propuestas a la receta guardada' })
  @ApiOkResponse({ type: PrescriptionProposalOverviewDto })
  async link(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: LinkPrescriptionProposalDto,
    @Req() req: Request,
  ): Promise<PrescriptionProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.link(
        { encounterId, prescriptionId: dto.prescriptionId, lines: dto.lines },
        assistantRequester(this.currentUser, req, PRESCRIBING),
      ),
    );
  }

  /** AS-075. Discards a line. */
  @Post(':suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una línea propuesta' })
  @ApiOkResponse({ type: PrescriptionProposalOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<PrescriptionProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.discard(
        { encounterId, suggestionId },
        assistantRequester(this.currentUser, req, PRESCRIBING),
      ),
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}

/** Instants leave as ISO 8601. */
function toResponse(
  overview: PrescriptionOverview,
): PrescriptionProposalOverviewDto {
  return { ...overview, readAt: overview.readAt?.toISOString() ?? null };
}
