import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { VitalsHistoryService } from './application/vitals-history.service';
import {
  VitalsHistoryDto,
  type VitalsHistoryResponse,
} from './dto/vitals-history.dto';

/**
 * EN-269 to EN-272. The evolution of a chart's vital signs.
 *
 * `record:read`: the takings are clinical content, like the history. And
 * `'query'` scope, NOT `'global'` like the allergies: a taking hangs off an
 * attention, an attention happens at a site, and the doctor at the southern
 * branch reads the takings of her sites — the same cost `GET /encounters`
 * already pays (EN-121). The handler narrows.
 */
@ApiTags('encounter')
@Controller({ path: 'patients/:patientId', version: '1' })
export class PatientVitalsController {
  constructor(
    private readonly vitals: VitalsHistoryService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('vitals')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Evolución de los signos vitales del paciente' })
  @ApiOkResponse({ type: VitalsHistoryDto })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<VitalsHistoryResponse> {
    const scope = this.currentUser.requirePrincipal().sitesFor('record:read');
    const history = await this.vitals.forChart(patientId, {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return {
      patientId: history.patientId,
      // Instants leave as ISO 8601; the client renders them in Ecuadorian time.
      items: history.items.map((taking) => ({
        ...taking,
        measuredAt: taking.measuredAt.toISOString(),
      })),
      total: history.total,
      bloodPressureReference: history.bloodPressureReference,
    };
  }
}
