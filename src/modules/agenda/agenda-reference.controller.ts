import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { AgendaService } from './application/agenda.service';
import {
  AgendaServiceTypesDto,
  type AgendaServiceTypesResponse,
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

  /**
   * AG-108, AG-111. The guard checks the caller's scope over `:siteId` before
   * this runs.
   */
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

  /**
   * AG-112. The attention types of one specialty, under `agenda:read`.
   *
   * WHY THIS ROUTE EXISTS AT ALL, when `specialties` has served the same rows
   * since C1: that one asks for `config:read`, which is the administration
   * screen's permission and which `RECEPCION` does not hold. The booking
   * dialog built on it in C4 was therefore unreachable by the very role it was
   * built for. The fix is the one AG-108 already made for practitioners — the
   * agenda publishes the minimum its own screen needs — and not widening
   * recepción's grants until an administration catalogue fits through them.
   *
   * THE SITE IS IN THE PATH so `param:siteId` is enforceable by the guard,
   * exactly like the practitioner list above. It authorises; it does not
   * filter, because a `service_type` belongs to the clinic and not to a site.
   */
  @Get('sites/:siteId/specialties/:specialtyId/service-types')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({ summary: 'Tipos de atención de una especialidad' })
  @ApiOkResponse({ type: AgendaServiceTypesDto })
  async serviceTypes(
    @Param('siteId', ParseUUIDPipe) _siteId: string,
    @Param('specialtyId', ParseUUIDPipe) specialtyId: string,
  ): Promise<AgendaServiceTypesResponse> {
    const items = await this.agenda.serviceTypesOf(specialtyId);
    return { items };
  }
}
