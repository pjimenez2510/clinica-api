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
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  OrganizationService,
  type Requester,
} from './application/organization.service';
import type {
  EstablishmentView,
  SiteView,
} from './domain/organization.repository';
import {
  CreateSiteDto,
  EstablishmentDto,
  SaveDocumentIdentityDto,
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
 * THE SITE SCOPE. `global` on the establishment, and that one is genuinely
 * global: there is ONE establishment and it has no site. `param:id` on
 * everything that names one site, so the guard checks the caller's scope over
 * exactly that site before the handler runs. `'query'` on the LISTING, where
 * the guard has nothing to read and the handler narrows — it used to be
 * `global` on the argument that a filtered listing would leave a receptionist
 * with nothing to pick from, which was the wrong conclusion from a true
 * premise: a receptionist scoped to one site should be picking from that site,
 * and `POST /sites` is the route that creates one.
 *
 * WHAT THE RUC DOES NOT DO IS TRAVEL UNDER `site:read`. See `organization.dto`
 * for the reasoning; `visibleSite` and `visibleEstablishment` are where it is
 * applied, on the way out of every route that serves either shape.
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
    return this.visibleEstablishment(
      await this.organization.getEstablishment(),
    );
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
    return this.visibleEstablishment(
      await this.organization.saveEstablishment(
        {
          mspUnicode: dto.mspUnicode,
          typology: dto.typology,
          legalName: dto.legalName,
          ruc: dto.ruc,
          active: dto.active,
        },
        this.requester(req),
      ),
    );
  }

  /**
   * OR-010 to OR-012. Apart from the PUT above so the establishment form, which
   * does not show these three, cannot clear them by leaving them out.
   */
  @Put('establishment/document-identity')
  @RequirePermission('site:manage', 'global')
  @ApiOperation({
    summary: 'Nombre comercial, correo y permiso que imprimen los documentos',
  })
  @ApiOkResponse({ type: EstablishmentDto })
  async saveDocumentIdentity(
    @Body() dto: SaveDocumentIdentityDto,
    @Req() req: Request,
  ): Promise<EstablishmentResponse> {
    return this.visibleEstablishment(
      await this.organization.saveDocumentIdentity(
        {
          tradeName: dto.tradeName,
          contactEmail: dto.contactEmail,
          operatingPermit: dto.operatingPermit,
        },
        this.requester(req),
      ),
    );
  }

  // --- Sites ------------------------------------------------------------------

  /**
   * OR-007: deactivated sites travel only when explicitly asked for.
   *
   * `'query'` site scope: there is no site in the URL for the guard to check,
   * so the HANDLER narrows and the caller's own resolved scope IS the filter —
   * the same shape as `GET /agenda/sites` (AG-107). It used to be `global`,
   * and the consequence was that a caller scoped to one city received the
   * name, MSP code, RUC, address and phone of every site of the clinic from
   * this route while `GET /sites/:id` refused them the very same row.
   */
  @Get('sites')
  @RequirePermission('site:read', 'query')
  @ApiOperation({ summary: 'Sedes que quien llama puede consultar' })
  @ApiOkResponse({ type: SiteListDto })
  async listSites(@Query() query: ListQueryDto): Promise<SiteListResponse> {
    const scope = this.currentUser.requirePrincipal().sitesFor('site:read');
    const items = await this.organization.listSites(
      query.includeInactive,
      scope === ALL_SITES ? 'all' : scope,
    );
    return { items: items.map((site) => this.visibleSite(site)) };
  }

  /**
   * OR-004. The guard checks the site in the URL against the caller's scope
   * before the handler runs; the RUC is then filtered by `visibleSite`.
   */
  @Get('sites/:id')
  @RequirePermission('site:read', 'param:id')
  @ApiOperation({ summary: 'Datos de una sede' })
  @ApiOkResponse({ type: SiteDto })
  async getSite(@Param('id', ParseUUIDPipe) id: string): Promise<SiteResponse> {
    return this.visibleSite(await this.organization.getSite(id));
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
    return this.visibleSite(
      await this.organization.createSite(
        {
          mspUnicode: dto.mspUnicode,
          name: dto.name,
          ruc: dto.ruc,
          parishConceptId: dto.parishConceptId,
          addressLine: dto.addressLine,
          phone: dto.phone,
        },
        this.requester(req),
      ),
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
    return this.visibleSite(
      await this.organization.updateSite(
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
      ),
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

  /**
   * OR-025. The RUC, only for a caller who administers sites.
   *
   * The first ten digits of a natural-person RUC ARE the owner's cedula
   * (`ruc.vo.ts`), so a single-practitioner clinic registered under its
   * doctor's own RUC was handing that doctor's national ID to reception and to
   * nursing through `site:read` — a permission every clinical role holds
   * because it is how they learn which sites and rooms exist. The RUC serves
   * billing (OR-025); booking an appointment is not billing.
   *
   * OMITTED, never nulled: `null` already means «no tiene RUC», which a screen
   * acts on, and «no le corresponde» is a different answer. Applied on the way
   * out of every route, including the ones behind `site:manage`, so there is
   * one place to read rather than a rule each handler remembers.
   */
  private visibleSite(site: SiteView): SiteResponse {
    const { ruc, ...rest } = site;
    return this.administersSites() ? { ...rest, ruc } : rest;
  }

  /** See `visibleSite`. The establishment's RUC is the same document. */
  private visibleEstablishment(
    establishment: EstablishmentView,
  ): EstablishmentResponse {
    const { ruc, ...rest } = establishment;
    return this.administersSites() ? { ...rest, ruc } : rest;
  }

  /**
   * `site:manage` held at ANY site, not necessarily the one being read: it
   * decides whether the RUC travels, not access to the row.
   */
  private administersSites(): boolean {
    return this.currentUser.requirePrincipal().can('site:manage');
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
