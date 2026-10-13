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
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../shared/clinical/assistant-site-switch.port';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  OrderProposalService,
  type OrdersOverview,
} from './application/order-proposal.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { assistantRequester } from './assistant-requester';
import {
  LinkOrderProposalDto,
  OrderProposalOverviewDto,
  OrderProposalReadingDto,
} from './dto/order-proposal.dto';

/**
 * AS-103 to AS-111. The exams the assistant proposes in Exámenes.
 *
 * Same door as the CIE-10 and the receta (AS-026): `assistant:use` with
 * `'query'` scope, narrowed in the service to the caller's own `record:read`
 * / `record:write` sites — `record:write` is what orders an exam (ORD-001) —
 * and a 404 from the middleware while `ASSISTANT_ENABLED` is off.
 *
 * ⚠️ NO ROUTE HERE WRITES AN ORDER. The exam chosen goes to the draft
 * through the order's own route, with its checks and its `If-Match`
 * (ORD-095, ORD-181); `link` only records which line came from which
 * proposal (P1, AS-108, AS-109).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/orders', version: '1' }) // prettier-ignore
export class AssistantOrdersController {
  constructor(
    private readonly proposals: OrderProposalService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  /** AS-106, AS-107. The exams of the latest reading, resolved now. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Exámenes propuestos por el asistente' })
  @ApiOkResponse({ type: OrderProposalOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<OrderProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.overview(encounterId, await assistantRequester(this.currentUser, this.siteSwitch, req)), // prettier-ignore
    );
  }

  /** AS-103 to AS-107, AS-112. «Proponer exámenes». */
  @Post('read')
  @RequirePermission('assistant:use', 'query')
  // AS-112. Six a minute is asking again, not a loop.
  @Throttle({ long: { ttl: 60_000, limit: 6 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Proponer exámenes leyendo la nota y la conversación' }) // prettier-ignore
  @ApiOkResponse({ type: OrderProposalReadingDto })
  async read(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<OrderProposalReadingDto> {
    this.requireEnabled();
    const reading = await this.proposals.read(encounterId, await assistantRequester(this.currentUser, this.siteSwitch, req)); // prettier-ignore
    return {
      ...toResponse(reading),
      found: reading.found,
      dropped: reading.dropped,
    };
  }

  /** AS-109. Links the proposals to the exams of the order saved from them. */
  @Post('link')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enlazar los exámenes propuestos a la orden guardada' }) // prettier-ignore
  @ApiOkResponse({ type: OrderProposalOverviewDto })
  async link(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: LinkOrderProposalDto,
    @Req() req: Request,
  ): Promise<OrderProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.link(
        { encounterId, serviceOrderId: dto.serviceOrderId, lines: dto.lines },
        await assistantRequester(this.currentUser, this.siteSwitch, req),
      ),
    );
  }

  /** AS-110. Discards a line. */
  @Post(':suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar un examen propuesto' })
  @ApiOkResponse({ type: OrderProposalOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<OrderProposalOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.proposals.discard(
        { encounterId, suggestionId },
        await assistantRequester(this.currentUser, this.siteSwitch, req),
      ),
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}

/** Instants leave as ISO 8601. */
function toResponse(overview: OrdersOverview): OrderProposalOverviewDto {
  return { ...overview, readAt: overview.readAt?.toISOString() ?? null };
}
