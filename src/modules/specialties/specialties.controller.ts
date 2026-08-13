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

import {
  SpecialtiesService,
  type Requester,
} from './application/specialties.service';
import {
  CreateServiceTypeDto,
  CreateSpecialtyDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListServiceTypesQueryDto,
  ListSpecialtiesQueryDto,
  ServiceTypeDto,
  ServiceTypeListDto,
  SpecialtyDto,
  SpecialtyListDto,
  UpdateServiceTypeDto,
  UpdateSpecialtyDto,
  type ServiceTypeListResponse,
  type ServiceTypeResponse,
  type SpecialtyListResponse,
  type SpecialtyResponse,
} from './dto/specialties.dto';

/**
 * The clinic's parametrisation: specialties, service types, durations (C1).
 *
 * EVERY ROUTE DECLARES ITS PERMISSION, and every one is `'global'` — a
 * decision, not an omission: a specialty or a duration is the same at every
 * site, like a catalogue and unlike an appointment. What IS split is read
 * from write: `config:read` serves the selection screens, `config:manage` is
 * the administration permission of D-002 that every mutation demands.
 */
@ApiTags('specialties')
@Controller({ path: 'specialties', version: '1' })
export class SpecialtiesController {
  constructor(
    private readonly specialties: SpecialtiesService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- Specialties ----------------------------------------------------------

  /** SP-007: deactivated rows travel only when explicitly asked for. */
  @Get()
  @RequirePermission('config:read', 'global')
  @ApiOperation({ summary: 'List specialties' })
  @ApiOkResponse({ type: SpecialtyListDto })
  async listSpecialties(
    @Query() query: ListSpecialtiesQueryDto,
  ): Promise<SpecialtyListResponse> {
    const items = await this.specialties.listSpecialties(query.includeInactive);
    return { items };
  }

  /** SP-002. */
  @Post()
  @RequirePermission('config:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a specialty' })
  @ApiCreatedResponse({ type: SpecialtyDto })
  async createSpecialty(
    @Body() dto: CreateSpecialtyDto,
    @Req() req: Request,
  ): Promise<SpecialtyResponse> {
    return this.specialties.createSpecialty(
      { code: dto.code, name: dto.name },
      this.requester(req),
    );
  }

  /** SP-002 (rename), SP-004 (deactivate). */
  @Patch(':id')
  @RequirePermission('config:manage', 'global')
  @ApiOperation({ summary: 'Rename or (de)activate a specialty' })
  @ApiOkResponse({ type: SpecialtyDto })
  async updateSpecialty(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSpecialtyDto,
    @Req() req: Request,
  ): Promise<SpecialtyResponse> {
    return this.specialties.updateSpecialty(
      id,
      { name: dto.name, active: dto.active },
      this.requester(req),
    );
  }

  /** SP-003: refused with `SPECIALTY_IN_USE` when anything references it. */
  @Delete(':id')
  @RequirePermission('config:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unreferenced specialty' })
  @ApiNoContentResponse()
  async deleteSpecialty(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.specialties.deleteSpecialty(id, this.requester(req));
  }

  // --- Service types ----------------------------------------------------------

  @Get(':id/service-types')
  @RequirePermission('config:read', 'global')
  @ApiOperation({ summary: 'List the service types of a specialty' })
  @ApiOkResponse({ type: ServiceTypeListDto })
  async listServiceTypes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListServiceTypesQueryDto,
  ): Promise<ServiceTypeListResponse> {
    const items = await this.specialties.listServiceTypes(
      id,
      query.includeInactive,
    );
    return { items };
  }

  /** SP-020. */
  @Post(':id/service-types')
  @RequirePermission('config:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a service type with its base duration' })
  @ApiCreatedResponse({ type: ServiceTypeDto })
  async createServiceType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateServiceTypeDto,
    @Req() req: Request,
  ): Promise<ServiceTypeResponse> {
    return this.specialties.createServiceType(
      {
        specialtyId: id,
        name: dto.name,
        durationMinutes: dto.durationMinutes,
      },
      this.requester(req),
    );
  }

  /** SP-024: a duration change rules forwards; no appointment is touched. */
  @Patch('service-types/:id')
  @RequirePermission('config:manage', 'global')
  @ApiOperation({ summary: 'Edit a service type' })
  @ApiOkResponse({ type: ServiceTypeDto })
  async updateServiceType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceTypeDto,
    @Req() req: Request,
  ): Promise<ServiceTypeResponse> {
    return this.specialties.updateServiceType(
      id,
      {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        active: dto.active,
      },
      this.requester(req),
    );
  }

  /** SP-025: refused with `SERVICE_TYPE_IN_USE` when appointments reference it. */
  @Delete('service-types/:id')
  @RequirePermission('config:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an unreferenced service type' })
  @ApiNoContentResponse()
  async deleteServiceType(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.specialties.deleteServiceType(id, this.requester(req));
  }

  /** Who is asking, for the trail (SP-002, SP-027). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
