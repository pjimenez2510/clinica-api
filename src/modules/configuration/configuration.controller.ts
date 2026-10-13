import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../shared/clinical/assistant-site-switch.port';
import { ASSISTANT_ENABLED } from '../../shared/config/assistant-enabled';
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/configuration-audit.trail';
import { HolidaysService } from './application/holidays.service';
import { SiteParametersService } from './application/site-parameters.service';
import {
  AssistantSitesDto,
  CreateHolidayDto,
  HolidayDto,
  HolidayListDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListHolidaysQueryDto,
  RecordRetentionDto,
  SiteParametersDto,
  UpdateHolidayDto,
  UpdateSiteParametersDto,
  type AssistantSitesResponse,
  type HolidayListResponse,
  type HolidayResponse,
  type RecordRetentionResponse,
  type SiteParametersResponse,
} from './dto/configuration.dto';

/**
 * Holidays and the operating parameters of each site (C3: CF-060..CF-066),
 * including the two rules `agenda` declares and this module administers: which
 * sites work a holiday (AG-092) and whether a site admits booking in the past
 * (AG-031, AG-094).
 *
 * WHY `settings:read` AND `settings:manage`, and not `config:*`. `config:*`
 * covers specialties, attention types and durations — master data the record
 * and the invoice reference. These are parameters: numbers that change
 * behaviour and that no row points at (ADR-011). D-002's prose says
 * `settings:read`/`settings:write`; the pair is named `read`/`manage` here
 * because every other administration pair in the catalogue is, and one odd
 * verb in a closed union is a typo waiting to compile.
 *
 * THE SITE SCOPE, stated rather than assumed.
 *
 *   - The parameter routes name ONE site in the path, so they are
 *     `param:siteId` and the guard checks the caller's scope over exactly that
 *     site before the handler runs. That is the strongest form available.
 *   - The holiday routes that create, edit and delete declare `'query'`
 *     (CF-067, D-023). Their scope arrives in the BODY — on the delete, in the
 *     ROW — and guards run before the pipes, so there is nothing validated for
 *     the guard to check at that moment; `global` claimed those routes had no
 *     site dimension, which was false. The HANDLER settles it with the
 *     caller's own resolved scope, and `site_id IS NULL` — «todas las sedes» —
 *     demands `settings:manage` granted clinic-wide, because a national
 *     holiday shuts every site's agenda.
 *   - The LISTING stays `global` and stays unnarrowed, for a reason that
 *     points the other way: the rows with `site_id IS NULL` belong to no site
 *     and every site obeys them, so narrowing the query by the caller's sites
 *     would HIDE exactly the holidays that apply everywhere. Reading the
 *     calendar shuts nobody's agenda.
 *   - The AG-092 exception routes are the exception to that exception: their
 *     site is IN THE PATH, so they are `param:siteId` like the parameter
 *     routes and the guard settles the scope before the handler runs.
 */
@ApiTags('configuration')
@Controller({ path: 'configuration', version: '1' })
export class ConfigurationController {
  constructor(
    private readonly holidays: HolidaysService,
    private readonly parameters: SiteParametersService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly assistantInstalled: boolean,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly assistantSwitch: AssistantSiteSwitch,
  ) {}

  // --- Holidays --------------------------------------------------------------

  /** CF-060: the year's calendar, optionally as one site observes it. */
  @Get('holidays')
  @RequirePermission('settings:read', 'global')
  @ApiOperation({ summary: 'Feriados de un año' })
  @ApiOkResponse({ type: HolidayListDto })
  async listHolidays(
    @Query() query: ListHolidaysQueryDto,
  ): Promise<HolidayListResponse> {
    const items = await this.holidays.list({
      year: query.year,
      siteId: query.siteId,
    });
    return { items };
  }

  /** CF-060, CF-061, CF-066, CF-067. */
  @Post('holidays')
  @RequirePermission('settings:manage', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un feriado' })
  @ApiCreatedResponse({ type: HolidayDto })
  async createHoliday(
    @Body() dto: CreateHolidayDto,
    @Req() req: Request,
  ): Promise<HolidayResponse> {
    return this.holidays.create(
      { date: dto.date, name: dto.name, siteId: dto.siteId },
      this.requester(req),
      // CF-067: the scope comes from the session the guard resolved, never
      // from the request — a body that could widen it would be no check.
      this.currentUser.requirePrincipal(),
    );
  }

  /** CF-060, CF-061, CF-066, CF-067. */
  @Patch('holidays/:id')
  @RequirePermission('settings:manage', 'query')
  @ApiOperation({ summary: 'Editar un feriado' })
  @ApiOkResponse({ type: HolidayDto })
  async updateHoliday(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidayDto,
    @Req() req: Request,
  ): Promise<HolidayResponse> {
    return this.holidays.update(
      id,
      { date: dto.date, name: dto.name, siteId: dto.siteId },
      this.requester(req),
      this.currentUser.requirePrincipal(),
    );
  }

  /** CF-066, CF-067. Nothing references a holiday, so it is deleted and not disabled. */
  @Delete('holidays/:id')
  @RequirePermission('settings:manage', 'query')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un feriado' })
  @ApiNoContentResponse()
  async deleteHoliday(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.holidays.delete(
      id,
      this.requester(req),
      this.currentUser.requirePrincipal(),
    );
  }

  /**
   * AG-092, CF-066. This site works this holiday: urgencias abre el 25 de
   * diciembre y las demás sedes siguen cerradas.
   *
   * A PUT, because the pair is the primary key: marking it twice is the same
   * statement, and the second click deserves «hecho» rather than a 409.
   *
   * `param:siteId` AND NOT `global`, unlike the holiday routes above. Those
   * carry their scope in the BODY, which the guard cannot see; this one has
   * the site in the URL, so the guard checks the caller's scope over exactly
   * that site before the handler runs — and a route whose URL names a site and
   * declares `global` is caught by `route-authorisation.spec.ts`.
   */
  @Put('holidays/:id/worked-by/:siteId')
  @RequirePermission('settings:manage', 'param:siteId')
  @ApiOperation({ summary: 'Marcar que una sede trabaja un feriado' })
  @ApiOkResponse({ type: HolidayDto })
  async markHolidayWorkedBy(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Req() req: Request,
  ): Promise<HolidayResponse> {
    return this.holidays.markWorkedBy(id, siteId, this.requester(req));
  }

  /**
   * AG-092, CF-066. The site observes the holiday again.
   *
   * It answers with the HOLIDAY and not with 204: what changed is the
   * holiday's list of exceptions, and handing it back lets the screen replace
   * the row it already has instead of reloading the year.
   */
  @Delete('holidays/:id/worked-by/:siteId')
  @RequirePermission('settings:manage', 'param:siteId')
  @ApiOperation({ summary: 'Quitar que una sede trabaja un feriado' })
  @ApiOkResponse({ type: HolidayDto })
  async unmarkHolidayWorkedBy(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Req() req: Request,
  ): Promise<HolidayResponse> {
    return this.holidays.unmarkWorkedBy(id, siteId, this.requester(req));
  }

  // --- Site parameters -------------------------------------------------------

  /**
   * EN-032, EN-157, EN-158. The retention of the clinical record the
   * installation declares (LOPDP art. 51): the longest of its sites, from the
   * last attention, never purged. Read-only on purpose: the minimum is the
   * database's (`site_parameter_retention_minimum`) and no route lowers it.
   */
  @Get('record-retention')
  @RequirePermission('settings:read', 'global')
  @ApiOperation({ summary: 'Plazo de conservación de la historia clínica' })
  @ApiOkResponse({ type: RecordRetentionDto })
  async recordRetention(): Promise<RecordRetentionResponse> {
    return this.parameters.recordRetention();
  }

  /**
   * CF-062, AG-094: the four numbers of D-001 and the past booking switch,
   * with the site's current values. The switch travels in the ANSWER too — a
   * parameter an administrator cannot SEE is one they cannot rely on.
   */
  @Get('sites/:siteId/parameters')
  @RequirePermission('settings:read', 'param:siteId')
  @ApiOperation({ summary: 'Parámetros de operación de una sede' })
  @ApiOkResponse({ type: SiteParametersDto })
  async getParameters(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<SiteParametersResponse> {
    return {
      ...(await this.parameters.get(siteId)),
      assistantAvailable: this.assistantInstalled,
    };
  }

  /**
   * AS-162 (A3). The sites of the caller's reach with the assistant on: what
   * reception reads to know whether to ask for the authorization to record,
   * without `settings:read`. None while the installation has it off (AS-026).
   */
  @Get('assistant-sites')
  @RequirePermission('site:read', 'query')
  @ApiOperation({ summary: 'Sedes con el asistente encendido' })
  @ApiOkResponse({ type: AssistantSitesDto })
  async assistantSites(): Promise<AssistantSitesResponse> {
    if (!this.assistantInstalled) return { siteIds: [] };
    const scope = this.currentUser.requirePrincipal().sitesFor('site:read');
    const enabled = await this.assistantSwitch.enabledSites();
    return {
      siteIds:
        scope === ALL_SITES
          ? enabled
          : enabled.filter((site) => scope.includes(site)),
    };
  }

  /**
   * CF-064, CF-065, CF-066.
   *
   * A PUT and not a PATCH: there is exactly one parameter row per site, so
   * saving it twice is the same row and not two. The body's fields are all
   * optional anyway — an administrator raising the overbooking cap should not
   * have to resend three numbers they did not touch, and resending a stale
   * copy of them is how a concurrent edit gets silently reverted.
   */
  @Put('sites/:siteId/parameters')
  @RequirePermission('settings:manage', 'param:siteId')
  @ApiOperation({ summary: 'Cambiar los parámetros de operación de una sede' })
  @ApiOkResponse({ type: SiteParametersDto })
  async updateParameters(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: UpdateSiteParametersDto,
    @Req() req: Request,
  ): Promise<SiteParametersResponse> {
    const saved = await this.parameters.update(
      siteId,
      {
        minLeadMinutes: dto.minLeadMinutes,
        maxLeadDays: dto.maxLeadDays,
        overbookingCap: dto.overbookingCap,
        slotAtomMinutes: dto.slotAtomMinutes,
        allowPastBooking: dto.allowPastBooking,
        // AG-039, AG-101 (E4): el interruptor del sobrecupo y el permiso que
        // lo autoriza. Se enumeran uno a uno, como los demás, en vez de
        // esparcir el DTO: lo que este módulo guarda es una lista cerrada, y
        // un `...dto` haría de cada campo nuevo del transporte una columna por
        // accidente.
        overbookingEnabled: dto.overbookingEnabled,
        overbookingPermission: dto.overbookingPermission,
        // AG-066, AG-094 (E5): el octavo parámetro que AG-094 enumera y que
        // `site_parameter` no tuvo hasta que se abrió la lista de espera.
        waitlistMaxContactAttempts: dto.waitlistMaxContactAttempts,
        // AG-142 (E8): el umbral de llegada tardía y quién lo salta.
        lateArrivalGraceMinutes: dto.lateArrivalGraceMinutes,
        lateArrivalOverridePermission: dto.lateArrivalOverridePermission,
        cancelledRetention: dto.cancelledRetention,
        // ORD-046, ORD-063, ORD-065: la política de las colas de resultados
        // (D-050 §2 y §4). En los roles, `null` es un valor: quien pidió.
        criticalNoticeWithinMinutes: dto.criticalNoticeWithinMinutes,
        criticalEscalationRoleId: dto.criticalEscalationRoleId,
        // ORD-179 (D-207 §2): la guardia nominal, en vez de un rol.
        criticalEscalationUserId: dto.criticalEscalationUserId,
        // ORD-177 (D-207 §2): el read-back, un ajuste de la sede.
        criticalReadBackRequired: dto.criticalReadBackRequired,
        // AS-160 (A3): el asistente en la sede.
        assistantEnabled: dto.assistantEnabled,
        unmatchedResultOwnerRoleId: dto.unmatchedResultOwnerRoleId,
        unmatchedResultDeadlineHours: dto.unmatchedResultDeadlineHours,
        // EN-272 (D-207 §1): la línea de la TA de las gráficas de evolución.
        bpReferenceSystolic: dto.bpReferenceSystolic,
        bpReferenceDiastolic: dto.bpReferenceDiastolic,
      },
      this.requester(req),
    );
    return { ...saved, assistantAvailable: this.assistantInstalled };
  }

  /** Who is asking, for the trail (CF-066). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
