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

import {
  OrganizationService,
  type Requester,
} from './application/organization.service';
import {
  CreateSiteDto,
  EstablishmentDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListQueryDto,
  SaveEstablishmentDto,
  SiteDto,
  SiteListDto,
  UpdateSiteDto,
  type EstablishmentResponse,
  type SiteListResponse,
  type SiteResponse,
} from './dto/organization.dto';

/**
 * The establishment and its sites (O1).
 *
 * WHY THE PERMISSIONS ARE THE ONES THEY ARE. `site:manage` already existed in
 * the catalogue and on the administrator role — this delivery reuses it rather
 * than inventing a second administration permission for the same screen.
 * `site:read` is new, and it is what splits READING the clinic's map from
 * EDITING it: a receptionist has to know which sites and rooms exist to book
 * into them, and nothing about that implies being able to create one.
 *
 * THE SITE SCOPE. `global` on the establishment and on the listing, because
 * neither has a site: there is one establishment, and a listing that filtered
 * itself out of existence would leave a receptionist with nothing to pick
 * from. `param:id` on everything that names ONE site, so the guard checks the
 * caller's scope over exactly that site before the handler runs.
 */
@ApiTags('organization')
@Controller({ path: 'organization', version: '1' })
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- Establishment ---------------------------------------------------------

  /** OR-003: the MSP code, for whoever must write it on every attention. */
  @Get('establishment')
  @RequirePermission('site:read', 'global')
  @ApiOperation({ summary: 'Datos del establecimiento' })
  @ApiOkResponse({ type: EstablishmentDto })
  async getEstablishment(): Promise<EstablishmentResponse> {
    return this.organization.getEstablishment();
  }

  /**
   * OR-001, OR-002, OR-008. A PUT: there is ONE establishment, so saving it
   * twice is the same establishment and not two.
   */
  @Put('establishment')
  @RequirePermission('site:manage', 'global')
  @ApiOperation({ summary: 'Registrar o editar el establecimiento' })
  @ApiOkResponse({ type: EstablishmentDto })
  async saveEstablishment(
    @Body() dto: SaveEstablishmentDto,
    @Req() req: Request,
  ): Promise<EstablishmentResponse> {
    return this.organization.saveEstablishment(
      {
        mspUnicode: dto.mspUnicode,
        typology: dto.typology,
        legalName: dto.legalName,
        ruc: dto.ruc,
        active: dto.active,
      },
      this.requester(req),
    );
  }

  // --- Sites ------------------------------------------------------------------

  /** OR-007: deactivated sites travel only when explicitly asked for. */
  @Get('sites')
  @RequirePermission('site:read', 'global')
  @ApiOperation({ summary: 'Sedes del establecimiento' })
  @ApiOkResponse({ type: SiteListDto })
  async listSites(@Query() query: ListQueryDto): Promise<SiteListResponse> {
    const items = await this.organization.listSites(query.includeInactive);
    return { items };
  }

  @Get('sites/:id')
  @RequirePermission('site:read', 'param:id')
  @ApiOperation({ summary: 'Datos de una sede' })
  @ApiOkResponse({ type: SiteDto })
  async getSite(@Param('id', ParseUUIDPipe) id: string): Promise<SiteResponse> {
    return this.organization.getSite(id);
  }

  /** OR-004, OR-005, OR-008. */
  @Post('sites')
  @RequirePermission('site:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una sede' })
  @ApiCreatedResponse({ type: SiteDto })
  async createSite(
    @Body() dto: CreateSiteDto,
    @Req() req: Request,
  ): Promise<SiteResponse> {
    return this.organization.createSite(
      {
        mspUnicode: dto.mspUnicode,
        name: dto.name,
        ruc: dto.ruc,
        parishConceptId: dto.parishConceptId,
        addressLine: dto.addressLine,
        phone: dto.phone,
      },
      this.requester(req),
    );
  }

  /** OR-005, OR-007 (deactivate), OR-008. */
  @Patch('sites/:id')
  @RequirePermission('site:manage', 'param:id')
  @ApiOperation({ summary: 'Editar o desactivar una sede' })
  @ApiOkResponse({ type: SiteDto })
  async updateSite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteDto,
    @Req() req: Request,
  ): Promise<SiteResponse> {
    return this.organization.updateSite(
      id,
      {
        name: dto.name,
        ruc: dto.ruc,
        parishConceptId: dto.parishConceptId,
        addressLine: dto.addressLine,
        phone: dto.phone,
        active: dto.active,
      },
      this.requester(req),
    );
  }

  /** OR-006: refused with `SITE_IN_USE`, offering deactivation instead. */
  @Delete('sites/:id')
  @RequirePermission('site:manage', 'param:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar una sede sin referencias' })
  @ApiNoContentResponse()
  async deleteSite(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.organization.deleteSite(id, this.requester(req));
  }

  /** Who is asking, for the trail (OR-005). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
