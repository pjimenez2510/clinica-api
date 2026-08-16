import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ALL_SITES } from '../../shared/authorisation/principal';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { AgendaService } from './application/agenda.service';
import {
  NoShowMetricDto,
  NoShowMetricQueryDto,
  type NoShowMetricResponse,
} from './dto/agenda.dto';

/**
 * What the agenda's own data says about itself (SPEC §9).
 *
 * A CONTROLLER OF ITS OWN, and the reason is the same one that produced
 * `AgendaReferenceController`: the main controller is rooted at
 * `agenda/sites/:siteId`, and AG-080 asks for the rate BY SITE — a metric that
 * could only ever be asked one site at a time would not answer the requirement
 * at all. It is not folded into the reference controller either, whose whole
 * stated purpose is the lists the booking dialog selects from.
 *
 * `agenda:read` AND NOT A PERMISSION OF ITS OWN. What this serves is counted
 * agenda rows with no patient in them; whoever may look at the day may look at
 * how the days went. Inventing `agenda:metrics:read` would mean a permission
 * no role carries and a screen nobody can open, which is the same argument
 * that kept blocking an hour under `agenda:write`.
 */
@ApiTags('agenda')
@Controller({ path: 'agenda', version: '1' })
export class AgendaMetricsController {
  constructor(
    private readonly agenda: AgendaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * AG-080, AG-081. The inasistencia rate over a range, by site, practitioner
   * and booking channel.
   *
   * `'query'` SITE SCOPE: there is no site in the URL for the guard to check,
   * because the breakdown by site IS the requirement, so the HANDLER narrows —
   * the caller's own resolved scope is the filter, and a receptionist hired at
   * Norte sees Norte's figures and not the clinic's (AG-071).
   *
   * A GET AND NOTHING STORED: asking twice must answer twice the same, save
   * for the window moving forward with the clock.
   */
  @Get('metrics/no-show')
  @RequirePermission('agenda:read', 'query')
  @ApiOperation({
    summary: 'Tasa de inasistencia por sede, profesional y canal',
  })
  @ApiOkResponse({ type: NoShowMetricDto })
  async noShowRate(
    @Query() query: NoShowMetricQueryDto,
  ): Promise<NoShowMetricResponse> {
    const scope = this.currentUser.requirePrincipal().sitesFor('agenda:read');

    const report = await this.agenda.noShowRate({
      sites: scope === ALL_SITES ? 'all' : scope,
      from: query.from,
      to: query.to,
    });

    return {
      from: query.from,
      to: query.to,
      // AG-081. What the figure was actually computed over, which is not the
      // range that was asked for whenever it reaches into the future.
      countedUntil: report.countedUntil.toISOString(),
      overall: report.overall,
      bySite: report.bySite,
      byPractitioner: report.byPractitioner,
      byChannel: report.byChannel,
    };
  }
}
