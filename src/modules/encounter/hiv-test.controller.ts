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
import { HivTestService } from './application/hiv-test.service';
import type { HivTestRecord } from './domain/hiv-test';
import {
  HivTestDto,
  HivTestSheetDto,
  RecordHivTestDto,
  type HivTestResponse,
  type HivTestSheetResponse,
} from './dto/hiv-test.dto';

/**
 * Block J of the RDACAA: the HIV test (EN-094, EN-095, EN-098).
 *
 * A CONTROLLER OF ITS OWN BECAUSE THE DOOR IS ITS OWN, like the violence
 * screening's: next to the other program blocks it would be one forgotten
 * check from travelling with them. This is the ONLY route that reads
 * `encounter_hiv_test`. The path names the section —«restricted»— and not
 * the content, like the permission: the HTTP log keeps the path.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId/programs', version: '1' })
export class HivTestController {
  constructor(
    private readonly tests: HivTestService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-095. With `record:read`; without the second key at the site, `{}`. */
  @Get('restricted')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar la sección restringida de los bloques de programa' }) // prettier-ignore
  @ApiOkResponse({ type: HivTestSheetDto })
  async testOf(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<HivTestSheetResponse> {
    const principal = this.currentUser.requirePrincipal();
    const sheet = await this.tests.testOf(
      encounterId,
      this.requester(req, sitesOf(principal.sitesFor('record:read'))),
      (siteId) => principal.canAtSite('record:protected', siteId),
    );
    if (!sheet.visible) return {};
    return { test: sheet.test && toResponse(sheet.test) };
  }

  /**
   * EN-094, EN-249. The guard asks for the second key; the scope is where the
   * caller ALSO holds `record:write`, so the key alone never writes.
   */
  @Put('restricted')
  @RequirePermission('record:protected', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar la sección restringida de los bloques de programa' }) // prettier-ignore
  @ApiOkResponse({ type: HivTestDto })
  async record(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordHivTestDto,
    @Req() req: Request,
  ): Promise<HivTestResponse> {
    const principal = this.currentUser.requirePrincipal();
    const sites = intersect(
      sitesOf(principal.sitesFor('record:protected')),
      sitesOf(principal.sitesFor('record:write')),
    );
    return toResponse(
      await this.tests.record(
        encounterId,
        {
          reason: dto.reason,
          screening: { ...dto.screening },
          confirmation: dto.confirmation && { ...dto.confirmation },
          transmissionRoute: dto.transmissionRoute,
          viralLoad: dto.viralLoad,
          cd4: dto.cd4,
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

function toResponse(record: HivTestRecord): HivTestResponse {
  return {
    reason: record.reason,
    screening: { ...record.screening },
    confirmation: record.confirmation && { ...record.confirmation },
    transmissionRoute: record.transmissionRoute,
    viralLoad: record.viralLoad,
    cd4: record.cd4,
    recordedAt: record.recordedAt.toISOString(),
    editedAt: record.editedAt?.toISOString() ?? null,
  };
}
