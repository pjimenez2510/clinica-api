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
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../shared/clinical/assistant-site-switch.port';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  type ChartOverview,
  ChartProposalService,
  type ChartRequester,
} from './application/chart-proposal.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { withAssistant } from './assistant-sites';
import {
  AcceptChartProposalDto,
  ChartOverviewDto,
} from './dto/chart-proposal.dto';

/**
 * AS-263 to AS-265. What the conversation said of the chart, proposed as its
 * records in Antecedentes. The record itself is made by the chart's own
 * routes (`POST /patients/:id/allergies`, `…/none-known`, `…/history`); here
 * the proposal is only linked to it or discarded (P1).
 *
 * `assistant:use` with `'query'` scope, like the draft: the service narrows
 * with the caller's `record:write` sites crossed with the assistant's, and
 * only the attention's professional gets an answer (AS-039). Without
 * `ASSISTANT_ENABLED`, a 404 before anything else (AS-026).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/chart', version: '1' })
export class AssistantChartController {
  constructor(
    private readonly chart: ChartProposalService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  /** AS-263. The proposals of the chart of the latest reading. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Alergias y antecedentes propuestos por el asistente' }) // prettier-ignore
  @ApiOkResponse({ type: ChartOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ChartOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.chart.overview(encounterId, await this.requester(req))); // prettier-ignore
  }

  /** AS-265. Links a proposal to the record just made by the chart's route. */
  @Post(':suggestionId/accept')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enlazar una propuesta de la ficha con lo registrado' }) // prettier-ignore
  @ApiOkResponse({ type: ChartOverviewDto })
  async accept(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Body() dto: AcceptChartProposalDto,
    @Req() req: Request,
  ): Promise<ChartOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.chart.accept(
        { encounterId, suggestionId, recordId: dto.recordId },
        await this.requester(req),
      ),
    );
  }

  /** AS-265. Discards a proposal of the chart. */
  @Post(':suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una propuesta de la ficha' })
  @ApiOkResponse({ type: ChartOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<ChartOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.chart.discard({ encounterId, suggestionId }, await this.requester(req)), // prettier-ignore
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private async requester(req: Request): Promise<ChartRequester> {
    const principal = this.currentUser.requirePrincipal();
    const enabled = await this.siteSwitch.enabledSites();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites: withAssistant(principal, 'record:write', enabled),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Every kind carries every field, null where it does not apply. */
function toResponse(overview: ChartOverview): ChartOverviewDto {
  return {
    demo: overview.demo,
    proposals: overview.proposals.map((each) => ({
      id: each.id,
      kind: each.kind,
      text: each.text,
      quote: each.quote,
      fromMs: each.fromMs,
      toMs: each.toMs,
      substance: each.kind === 'chart-allergy' ? each.substance : null,
      substanceConceptId:
        each.kind === 'chart-allergy'
          ? (each.substanceConceptId ?? null)
          : null,
      reaction: each.kind === 'chart-allergy' ? each.reaction : null,
      history: each.kind === 'chart-history' ? each.history : null,
      description: each.kind === 'chart-history' ? each.description : null,
      relative: each.kind === 'chart-history' ? each.relative : null,
      conflict: each.conflict,
      demo: (each as { demo?: unknown }).demo === true,
    })),
  };
}
