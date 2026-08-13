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

import type { Requester } from './application/organization.service';
import { SiteResourcesService } from './application/site-resources.service';
import {
  CreateEmissionPointDto,
  CreateRoomDto,
  EmissionPointDto,
  EmissionPointListDto,
  // NO `import type` for parameter DTOs — see organization.controller.ts.
  ListQueryDto,
  RoomDto,
  RoomListDto,
  UpdateEmissionPointDto,
  UpdateRoomDto,
  type EmissionPointListResponse,
  type EmissionPointResponse,
  type RoomListResponse,
  type RoomResponse,
} from './dto/organization.dto';

/**
 * Consulting rooms and points of emission (O2).
 *
 * A SECOND CONTROLLER under the same `organization` prefix, mirroring the two
 * services: `SiteResourcesService` owns what hangs off a site, and a single
 * controller with fourteen routes would hide which half a change belongs to.
 *
 * THE SITE SCOPE, and the one place it is honestly weaker. Creating and
 * listing name the site in the URL, so they are `param:siteId` and the guard
 * enforces the caller's scope. Editing and deleting name the ROOM or the
 * POINT, whose site the guard cannot know: guards run before pipes and before
 * any database read, so there is nothing to check against. They are declared
 * `global` — which is the truth, not a shrug — and what carries the weight
 * there is `site:manage`, an administration permission that DEFAULT_ROLES
 * grants clinic-wide and to one role only. Narrowing it further would mean
 * putting the site back in the path, which the SPEC's URL shape does not.
 */
@ApiTags('organization')
@Controller({ path: 'organization', version: '1' })
export class SiteResourcesController {
  constructor(
    private readonly resources: SiteResourcesService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- Consulting rooms -------------------------------------------------------

  /** OR-020, OR-022: deactivated rooms only on explicit request. */
  @Get('sites/:siteId/rooms')
  @RequirePermission('site:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultorios de una sede' })
  @ApiOkResponse({ type: RoomListDto })
  async listRooms(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: ListQueryDto,
  ): Promise<RoomListResponse> {
    const items = await this.resources.listRooms(siteId, query.includeInactive);
    return { items };
  }

  /** OR-020, OR-026. */
  @Post('sites/:siteId/rooms')
  @RequirePermission('site:manage', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un consultorio en una sede' })
  @ApiCreatedResponse({ type: RoomDto })
  async createRoom(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: CreateRoomDto,
    @Req() req: Request,
  ): Promise<RoomResponse> {
    return this.resources.createRoom(siteId, dto.name, this.requester(req));
  }

  /** OR-022 (deactivate), OR-026. */
  @Patch('rooms/:id')
  @RequirePermission('site:manage', 'global')
  @ApiOperation({ summary: 'Renombrar o desactivar un consultorio' })
  @ApiOkResponse({ type: RoomDto })
  async updateRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoomDto,
    @Req() req: Request,
  ): Promise<RoomResponse> {
    return this.resources.updateRoom(
      id,
      { name: dto.name, active: dto.active },
      this.requester(req),
    );
  }

  /** OR-022: refused with `SITE_ROOM_IN_USE`, offering deactivation instead. */
  @Delete('rooms/:id')
  @RequirePermission('site:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un consultorio sin citas' })
  @ApiNoContentResponse()
  async deleteRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.resources.deleteRoom(id, this.requester(req));
  }

  // --- Points of emission -----------------------------------------------------

  /** OR-023, OR-025: data for billing, with no sequential attached. */
  @Get('sites/:siteId/emission-points')
  @RequirePermission('site:read', 'param:siteId')
  @ApiOperation({ summary: 'Puntos de emisión del SRI de una sede' })
  @ApiOkResponse({ type: EmissionPointListDto })
  async listEmissionPoints(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: ListQueryDto,
  ): Promise<EmissionPointListResponse> {
    const items = await this.resources.listEmissionPoints(
      siteId,
      query.includeInactive,
    );
    return { items };
  }

  /** OR-023, OR-024, OR-026. */
  @Post('sites/:siteId/emission-points')
  @RequirePermission('site:manage', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un punto de emisión en una sede' })
  @ApiCreatedResponse({ type: EmissionPointDto })
  async createEmissionPoint(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: CreateEmissionPointDto,
    @Req() req: Request,
  ): Promise<EmissionPointResponse> {
    return this.resources.createEmissionPoint(
      siteId,
      { code: dto.code, description: dto.description },
      this.requester(req),
    );
  }

  /** OR-026. The code itself is not editable — see the DTO for why. */
  @Patch('emission-points/:id')
  @RequirePermission('site:manage', 'global')
  @ApiOperation({ summary: 'Editar o desactivar un punto de emisión' })
  @ApiOkResponse({ type: EmissionPointDto })
  async updateEmissionPoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmissionPointDto,
    @Req() req: Request,
  ): Promise<EmissionPointResponse> {
    return this.resources.updateEmissionPoint(
      id,
      { description: dto.description, active: dto.active },
      this.requester(req),
    );
  }

  /** OR-026. */
  @Delete('emission-points/:id')
  @RequirePermission('site:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un punto de emisión' })
  @ApiNoContentResponse()
  async deleteEmissionPoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.resources.deleteEmissionPoint(id, this.requester(req));
  }

  /** Who is asking, for the trail (OR-026). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
