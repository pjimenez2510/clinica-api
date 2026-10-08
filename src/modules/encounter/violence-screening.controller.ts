import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/encounter.service';
import { ViolenceScreeningService } from './application/violence-screening.service';
import type { ScreeningRecord } from './domain/violence-screening';
import {
  RecordScreeningDto,
  ScreeningDto,
  ScreeningSheetDto,
  type ScreeningResponse,
  type ScreeningSheetResponse,
} from './dto/violence-screening.dto';

/**
 * Block F of form 002: the violence screening (EN-070 to EN-078).
 *
 * A CONTROLLER OF ITS OWN BECAUSE THE DOOR IS ITS OWN, as
 * `PatientSexualOrientationController` argues: next to the attention's
 * handlers it would be one forgotten check from travelling with them. This
 * is the ONLY route that reads `violence_screening` (EN-073).
 *
 * The path names the section —«screening»— and not the content, like the
 * permission.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class ViolenceScreeningController {
  constructor(
    private readonly screenings: ViolenceScreeningService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-072, EN-075. With `record:read`, like the attention. Without the
   * second key at the attention's site the answer is `{}` — 200, never 403.
   */
  @Get('screening')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar el tamizaje de la atención' })
  @ApiOkResponse({ type: ScreeningSheetDto })
  async screening(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ScreeningSheetResponse> {
    const principal = this.currentUser.requirePrincipal();
    const sheet = await this.screenings.screeningOf(
      encounterId,
      this.requester(req, sitesOf(principal.sitesFor('record:read'))),
      (siteId) => principal.canAtSite('record:protected', siteId),
    );

    if (!sheet.visible) return {};
    return { screening: sheet.screening && toResponse(sheet.screening) };
  }

  /**
   * EN-070, EN-076. Answers or corrects it; with the discharge given, only
   * its notification to the authority (EN-242). The guard asks for the second
   * key; the scope is where the caller ALSO holds `record:write`, so the key
   * alone never writes the history.
   */
  @Put('screening')
  @RequirePermission('record:protected', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar el tamizaje de la atención' })
  @ApiOkResponse({ type: ScreeningDto })
  async record(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordScreeningDto,
    @Req() req: Request,
  ): Promise<ScreeningResponse> {
    const principal = this.currentUser.requirePrincipal();
    const sites = intersect(
      sitesOf(principal.sitesFor('record:protected')),
      sitesOf(principal.sitesFor('record:write')),
    );

    return toResponse(
      await this.screenings.record(
        encounterId,
        {
          result: dto.result,
          types: [...dto.types],
          actionTaken: dto.actionTaken || null,
          screeningTool: dto.screeningTool || null,
          notification: dto.notification
            ? {
                formSerial: dto.notification.formSerial,
                injury: dto.notification.injury,
                aggressorIdentified: dto.notification.aggressorIdentified,
                aggressorRelationship: dto.notification.aggressorRelationship,
              }
            : null,
        },
        this.requester(req, sites),
      ),
    );
  }

  private requester(req: Request, sites: Requester['sites']): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      sites,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function sitesOf(scope: typeof ALL_SITES | string[]): Requester['sites'] {
  return scope === ALL_SITES ? 'all' : scope;
}

/** Where the caller holds both. An empty list is a denial, never «no filter». */
function intersect(
  a: Requester['sites'],
  b: Requester['sites'],
): Requester['sites'] {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return a.filter((site) => b.includes(site));
}

function toResponse(record: ScreeningRecord): ScreeningResponse {
  return {
    result: record.result,
    types: [...record.types],
    actionTaken: record.actionTaken,
    screeningTool: record.screeningTool,
    notification: record.notification && { ...record.notification },
    screenedById: record.screenedById,
    screenedAt: record.screenedAt.toISOString(),
    notifiedById: record.notifiedById,
    notifiedAt: record.notifiedAt?.toISOString() ?? null,
  };
}
