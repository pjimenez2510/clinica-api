import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  IdentityLookupService,
  type IdentityLookupSettings,
  type Requester,
} from './application/identity-lookup.service';
import {
  IdentityLookupSettingsDto,
  // NO `import type` for parameter DTOs: Swagger would document the route
  // without its body (see catalogs.controller.ts).
  ProposalRequestDto,
  ProposalResponseDto,
  UpdateIdentityLookupSettingsDto,
  type IdentityLookupSettingsResponse,
  type ProposalResponse,
} from './dto/identity-lookup.dto';

/**
 * D-206. Proposing names by cedula, and the switch that allows it.
 *
 * `global` everywhere, on purpose: the chart belongs to the whole clinic and
 * registering has no active site (PA, `patient:write` is global too); the
 * switch is one for the clinic (IL-010).
 */
@ApiTags('identity-lookup')
@Controller({ path: 'identity-lookup', version: '1' })
export class IdentityLookupController {
  constructor(
    private readonly lookup: IdentityLookupService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * IL-001 to IL-007, IL-011. `POST` because the cedula travels in the body;
   * `200` and not `201` because nothing is created for the caller.
   *
   * IL-011: twenty a minute from one origin, under the global limits. A desk
   * registers far fewer; a script walking cedulas is cut here.
   */
  @Post('proposals')
  @RequirePermission('patient:write', 'global')
  @Throttle({ short: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Proponer nombres por la cédula' })
  @ApiOkResponse({ type: ProposalResponseDto })
  async propose(
    @Body() dto: ProposalRequestDto,
    @Req() req: Request,
  ): Promise<ProposalResponse> {
    const proposal = await this.lookup.propose(dto.cedula, this.requester(req));
    return {
      proposal: proposal && {
        source: proposal.source,
        sourceName: proposal.sourceName,
        familyName: proposal.familyName,
        secondFamilyName: proposal.secondFamilyName,
        givenName: proposal.givenName,
        secondGivenName: proposal.secondGivenName,
        birthDate: proposal.birthDate,
        orderToReview: proposal.orderToReview,
        lookedUpAt: proposal.lookedUpAt.toISOString(),
      },
    };
  }

  /** IL-010. */
  @Get('settings')
  @RequirePermission('settings:read', 'global')
  @ApiOperation({ summary: 'Nombres por cédula: interruptor y fuentes' })
  @ApiOkResponse({ type: IdentityLookupSettingsDto })
  async settings(): Promise<IdentityLookupSettingsResponse> {
    return toSettingsResponse(await this.lookup.settings());
  }

  /** IL-010. */
  @Put('settings')
  @RequirePermission('settings:manage', 'global')
  @ApiOperation({ summary: 'Encender o apagar las fuentes externas' })
  @ApiOkResponse({ type: IdentityLookupSettingsDto })
  async update(
    @Body() dto: UpdateIdentityLookupSettingsDto,
    @Req() req: Request,
  ): Promise<IdentityLookupSettingsResponse> {
    return toSettingsResponse(
      await this.lookup.setEnabled(dto.externalSourcesEnabled, this.requester(req)), // prettier-ignore
    );
  }

  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function toSettingsResponse(
  settings: IdentityLookupSettings,
): IdentityLookupSettingsResponse {
  return {
    ...settings,
    registry: settings.registry && {
      ...settings.registry,
      importedAt: settings.registry.importedAt.toISOString(),
    },
  };
}
