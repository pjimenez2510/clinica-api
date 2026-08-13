import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { AgendaService } from './application/agenda.service';
import {
  AgendaSitesDto,
  type AgendaSitesResponse,
  SchedulablePractitionersDto,
  type SchedulablePractitionersResponse,
} from './dto/agenda.dto';

/**
 * The reference lists the booking screen selects from (AG-107, AG-108).
 *
 * A SEPARATE controller because the main one is rooted at
 * `agenda/sites/:siteId` and the sites list, by definition, has no site yet.
 *
 * Found while building the E1 interface: grants travel with a bare `siteId`
 * and no route enumerated sites or practitioners, so a receptionist had no way
 * to pick where or with whom to book. "The API is ready" and "the API is
 * operable from a screen" turned out to be different claims.
 */
@ApiTags('agenda')
@Controller({ path: 'agenda', version: '1' })
export class AgendaReferenceController {
  constructor(
    private readonly agenda: AgendaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * AG-107. `'query'` site scope: there is no site in the URL to guard, so the
   * HANDLER narrows — the caller's own resolved scope IS the filter, and a
   * receptionist with one site sees one site, not the clinic's floor plan.
   */
  @Get('sites')
  @RequirePermission('agenda:read', 'query')
  @ApiOperation({ summary: 'Sedes donde quien llama puede agendar' })
  @ApiOkResponse({ type: AgendaSitesDto })
  async sites(): Promise<AgendaSitesResponse> {
    const scope = this.currentUser.requirePrincipal().sitesFor('agenda:read');
    const items = await this.agenda.sitesFor(
      scope === ALL_SITES ? 'all' : scope,
    );
    return { items };
  }

  /** AG-108. The guard checks the caller's scope over `:siteId` before this runs. */
  @Get('sites/:siteId/practitioners')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({ summary: 'Profesionales agendables de una sede' })
  @ApiOkResponse({ type: SchedulablePractitionersDto })
  async practitioners(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<SchedulablePractitionersResponse> {
    const items = await this.agenda.schedulablePractitioners(siteId);
    return { items };
  }
}
