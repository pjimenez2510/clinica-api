import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/configuration-audit.trail';
import { HolidaysService } from './application/holidays.service';
import { SiteParametersService } from './application/site-parameters.service';
import {
  CreateHolidayDto,
  HolidayDto,
  HolidayListDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListHolidaysQueryDto,
  SiteParametersDto,
  UpdateHolidayDto,
  UpdateSiteParametersDto,
  type HolidayListResponse,
  type HolidayResponse,
  type SiteParametersResponse,
} from './dto/configuration.dto';

/**
 * Holidays and the operating numbers of each site (C3: CF-060..CF-066).
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
 *   - The holiday routes are `global`, and it is the honest answer rather than
 *     a shrug. A holiday's scope arrives in the BODY, and guards run before
 *     the pipes — there is nothing validated to check against at that moment.
 *     The listing is `global` for a second reason that matters more: the rows
 *     with `site_id IS NULL` belong to no site and every site obeys them, so
 *     narrowing the query by the caller's sites would HIDE exactly the
 *     holidays that apply everywhere. What carries the weight there is
 *     `settings:manage`, an administration permission DEFAULT_ROLES grants
 *     clinic-wide and to one role only.
 */
@ApiTags('configuration')
@Controller({ path: 'configuration', version: '1' })
export class ConfigurationController {
  constructor(
    private readonly holidays: HolidaysService,
    private readonly parameters: SiteParametersService,
    private readonly currentUser: CurrentUserService,
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

  /** CF-060, CF-061, CF-066. */
  @Post('holidays')
  @RequirePermission('settings:manage', 'global')
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
    );
  }

  /** CF-060, CF-061, CF-066. */
  @Patch('holidays/:id')
  @RequirePermission('settings:manage', 'global')
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
    );
  }

  /** CF-066. Nothing references a holiday, so it is deleted and not disabled. */
  @Delete('holidays/:id')
  @RequirePermission('settings:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un feriado' })
  @ApiNoContentResponse()
  async deleteHoliday(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.holidays.delete(id, this.requester(req));
  }

  // --- Site parameters -------------------------------------------------------

  /** CF-062: the four numbers of D-001, with the site's current values. */
  @Get('sites/:siteId/parameters')
  @RequirePermission('settings:read', 'param:siteId')
  @ApiOperation({ summary: 'Parámetros de operación de una sede' })
  @ApiOkResponse({ type: SiteParametersDto })
  async getParameters(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<SiteParametersResponse> {
    return this.parameters.get(siteId);
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
    return this.parameters.update(
      siteId,
      {
        minLeadMinutes: dto.minLeadMinutes,
        maxLeadDays: dto.maxLeadDays,
        overbookingCap: dto.overbookingCap,
        cancelledRetention: dto.cancelledRetention,
      },
      this.requester(req),
    );
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
