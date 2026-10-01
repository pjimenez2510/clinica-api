import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { RequirePermission } from '../../shared/http/auth.decorators';
import { EncounterExitService } from './application/encounter-exit.service';
import type { Requester } from './application/encounter.service';
import {
  AnnulEncounterDto,
  DiscontinueEncounterDto,
  EncounterDto,
  type EncounterResponse,
} from './dto/encounter.dto';
import { toEncounterResponse } from './encounter.controller';

/**
 * EN-166, EN-167. The two exits of an attention that are not the discharge,
 * under the same `/encounters` prefix as the rest of the attention.
 *
 * A CONTROLLER OF ITS OWN so this delivery enters the module through new
 * files: the attention's controller is worked on by other deliveries at the
 * same time. The routes, the permission and the scope are the same kind as
 * the closure's (`record:write`, the caller's sites).
 */
@ApiTags('encounter')
@Controller({ path: 'encounters', version: '1' })
export class EncounterExitController {
  constructor(
    private readonly exits: EncounterExitService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-166, AG-147 (D-077, D-080). Annuls an attention opened by mistake.
   *
   * `record:write` and not `agenda:write` (D-080 §2): it is an act on the
   * clinical record. A route of its own and not a `PATCH` of the state, like
   * the closure: an act with an author, an instant and a reason.
   */
  @Post(':id/enter-in-error')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una atención abierta por error' })
  @ApiOkResponse({ type: EncounterDto })
  async annul(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnnulEncounterDto,
    @Req() req: Request,
  ): Promise<EncounterResponse> {
    return toEncounterResponse(
      await this.exits.annul(
        {
          encounterId: id,
          reason: dto.reason,
          substituteReason: dto.substituteReason,
          canSignRecords: this.currentUser
            .requirePrincipal()
            .can('record:sign'),
        },
        this.requester(req, 'record:write'),
      ),
    );
  }

  /**
   * EN-167, AG-149 (D-076, D-082). Interrupts an attention that cannot be
   * finished, signing the caller's drafts «con lo hecho».
   */
  @Post(':id/discontinue')
  // `record:sign` and not `record:write`: interrupting SIGNS the caller's
  // drafts (D-082), and a signature by somebody who cannot sign is the one
  // thing the ordinary route refuses (EN-027).
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Interrumpir una atención que no puede terminarse' })
  @ApiOkResponse({ type: EncounterDto })
  async discontinue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiscontinueEncounterDto,
    @Req() req: Request,
  ): Promise<EncounterResponse> {
    return toEncounterResponse(
      await this.exits.discontinue(
        {
          encounterId: id,
          reason: dto.reason,
          origin: dto.origin,
          substituteReason: dto.substituteReason,
          canSignRecords: true,
        },
        this.requester(req, 'record:sign'),
      ),
    );
  }

  /** The caller's identity and resolved scope for one permission. */
  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
