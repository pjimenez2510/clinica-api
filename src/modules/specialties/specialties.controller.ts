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
  CreateSpecialtyDto,
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  ListSpecialtiesQueryDto,
  SpecialtyDto,
  SpecialtyListDto,
  UpdateSpecialtyDto,
  type SpecialtyListResponse,
  type SpecialtyResponse,
} from './dto/specialties.dto';

/**
 * The clinic's specialties (C1).
 *
 * The service types and their durations left on 11-10-2026 (ADR-013): a
 * consultation is a service of kind CONSULTATION, listed by `billing`
 * (`GET /billing/services?kind=CONSULTATION&specialtyId=`) and by the agenda.
 *
 * EVERY ROUTE DECLARES ITS PERMISSION, and every one is `'global'` — a
 * decision, not an omission: a specialty is the same at every site, like a catalogue and unlike an appointment. What IS split is read
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
    // SP-009: only the name travels. The stable code is derived from it in the
    // service and comes back in the response — see `specialty-code.ts`.
    return this.specialties.createSpecialty(
      { name: dto.name },
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

  /** Who is asking, for the trail (SP-002). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
