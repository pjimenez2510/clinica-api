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

import { PractitionerAssignmentsService } from './application/practitioner-assignments.service';
import { PractitionerService } from './application/practitioner.service';
import type { Requester } from './application/staff-audit.trail';
import {
  // NO `import type` for parameter DTOs: with `type` the class is erased at
  // compile time, `design:paramtypes` emits `Object`, and Swagger documents
  // the endpoint WITHOUT its parameters — silently, end to end. See
  // catalogs.controller.ts.
  AcessExpiryListDto,
  AcessExpiryQueryDto,
  AssignSitesDto,
  AssignSpecialtiesDto,
  CreatePractitionerDto,
  ListPractitionersQueryDto,
  PractitionerDto,
  PractitionerDurationListDto,
  PractitionerListDto,
  PractitionerSiteListDto,
  PractitionerSpecialtyListDto,
  SetDurationExceptionDto,
  SigningEligibilityDto,
  UpdatePractitionerDto,
  type AcessExpiryListResponse,
  type PractitionerDurationListResponse,
  type PractitionerListResponse,
  type PractitionerResponse,
  type PractitionerSiteListResponse,
  type PractitionerSpecialtyListResponse,
  type SigningEligibilityResponse,
} from './dto/staff.dto';

/**
 * The practitioner's file: who they are, what habilitates them, where they
 * attend and what they practise (S1).
 *
 * EVERY ROUTE DECLARES ITS PERMISSION, and every one is `'global'` — a
 * decision, not an omission. A practitioner is not a resource OF a site: the
 * same person attends at two of them and their cedula, their ACESS and their
 * MSP code are the same in both, so scoping the file by site would mean either
 * hiding half a person or picking one of their sites arbitrarily. What IS
 * split is read from write: `staff:read` serves the administration screens and
 * whoever is about to sign, `staff:manage` is what every mutation demands.
 *
 * `staff:read` IS DELIBERATELY NARROW. The agenda lists bookable practitioners
 * through its own route under `agenda:read` (AG-108), so recepción and
 * medicina need nothing from here to work — and this file carries an
 * employee's cedula and ACESS registration, which is personal data with no
 * place on a booking screen.
 */
@ApiTags('staff')
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(
    private readonly practitioners: PractitionerService,
    private readonly assignments: PractitionerAssignmentsService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- Practitioners ---------------------------------------------------------

  /** ST-010: deactivated rows travel only when explicitly asked for. */
  @Get('practitioners')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Listar profesionales' })
  @ApiOkResponse({ type: PractitionerListDto })
  async listPractitioners(
    @Query() query: ListPractitionersQueryDto,
  ): Promise<PractitionerListResponse> {
    const items = await this.practitioners.list(query.includeInactive);
    return { items };
  }

  /**
   * ST-005. DECLARED BEFORE `:practitionerId` ON PURPOSE: NestJS matches in
   * declaration order, and with the parameter route first this path would be
   * swallowed by it and rejected as a malformed UUID.
   */
  @Get('practitioners/acess-expiring')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Profesionales con el ACESS por caducar' })
  @ApiOkResponse({ type: AcessExpiryListDto })
  async listAcessExpiring(
    @Query() query: AcessExpiryQueryDto,
  ): Promise<AcessExpiryListResponse> {
    const items = await this.practitioners.listAcessExpiring(query.withinDays);
    return { items };
  }

  @Get('practitioners/:practitionerId')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Ficha de un profesional' })
  @ApiOkResponse({ type: PractitionerDto })
  async getPractitioner(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
  ): Promise<PractitionerResponse> {
    return this.practitioners.get(practitionerId);
  }

  /** ST-001..ST-003, ST-006: the profile is attached to an existing account. */
  @Post('practitioners')
  @RequirePermission('staff:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Dar ficha profesional a una cuenta' })
  @ApiCreatedResponse({ type: PractitionerDto })
  async createPractitioner(
    @Body() dto: CreatePractitionerDto,
    @Req() req: Request,
  ): Promise<PractitionerResponse> {
    return this.practitioners.create(
      {
        userId: dto.userId,
        mspCode: dto.mspCode,
        schedulable: dto.schedulable,
      },
      this.requester(req),
    );
  }

  /** ST-001..ST-003, ST-006, ST-010 (deactivation). */
  @Patch('practitioners/:practitionerId')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Editar o desactivar un profesional' })
  @ApiOkResponse({ type: PractitionerDto })
  async updatePractitioner(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Body() dto: UpdatePractitionerDto,
    @Req() req: Request,
  ): Promise<PractitionerResponse> {
    return this.practitioners.update(
      practitionerId,
      {
        mspCode: dto.mspCode,
        schedulable: dto.schedulable,
        active: dto.active,
        cedula: dto.cedula,
        acessRegistration: dto.acessRegistration,
        acessExpiresOn: dto.acessExpiresOn,
      },
      this.requester(req),
    );
  }

  /**
   * ST-010. Refused with `PRACTITIONER_IN_USE` the moment there is an
   * appointment, an encounter or a signed document, and the refusal offers
   * deactivation — which is the PATCH above, not a different endpoint.
   */
  @Delete('practitioners/:practitionerId')
  @RequirePermission('staff:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un profesional sin historial' })
  @ApiNoContentResponse()
  async deletePractitioner(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.practitioners.delete(practitionerId, this.requester(req));
  }

  /**
   * ST-002, ST-004 — the signature-time check (D-009, REQ-041).
   *
   * A GET THAT REFUSES. Whoever is about to sign a note, a prescription or a
   * certificate asks this and an expired registration stops them with
   * `ACESS_EXPIRED`, naming the date. Answering 200 with `eligible: false`
   * would make the refusal optional for every future caller, and the first one
   * that forgot to read the flag would sign anyway.
   *
   * `agenda` DOES NOT CALL IT. D-009 settled that an expired ACESS blocks the
   * signature and never the booking, so nothing on the booking path depends on
   * this module.
   */
  @Get('practitioners/:practitionerId/signing-eligibility')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Comprobar que el profesional puede firmar hoy' })
  @ApiOkResponse({ type: SigningEligibilityDto })
  async signingEligibility(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
  ): Promise<SigningEligibilityResponse> {
    const status = await this.practitioners.assertMaySign(practitionerId);
    return {
      practitionerId,
      eligible: true,
      // Non-null once `assertMaySign` returned: a missing date is refused.
      acessExpiresOn: status.expiresOn ?? '',
      daysToExpiry: status.daysToExpiry ?? 0,
      expiringSoon: status.expiringSoon,
    };
  }

  // --- Sites (ST-007) --------------------------------------------------------

  @Get('practitioners/:practitionerId/sites')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Sedes donde atiende un profesional' })
  @ApiOkResponse({ type: PractitionerSiteListDto })
  async listSites(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
  ): Promise<PractitionerSiteListResponse> {
    const items = await this.assignments.listSites(practitionerId);
    return { items };
  }

  /** ST-007. The body is the WHOLE list — replace-set, hence a PUT. */
  @Put('practitioners/:practitionerId/sites')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Fijar las sedes donde atiende un profesional' })
  @ApiOkResponse({ type: PractitionerSiteListDto })
  async replaceSites(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Body() dto: AssignSitesDto,
    @Req() req: Request,
  ): Promise<PractitionerSiteListResponse> {
    const items = await this.assignments.replaceSites(
      practitionerId,
      dto.siteIds,
      this.requester(req),
    );
    return { items };
  }

  // --- Specialties (ST-008) --------------------------------------------------

  /** ST-008: the primary flag travels with each row, primary first. */
  @Get('practitioners/:practitionerId/specialties')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Especialidades que ejerce un profesional' })
  @ApiOkResponse({ type: PractitionerSpecialtyListDto })
  async listSpecialties(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
  ): Promise<PractitionerSpecialtyListResponse> {
    const items = await this.assignments.listSpecialties(practitionerId);
    return { items };
  }

  /**
   * ST-008: the body is the WHOLE assignment — replace-set semantics, which is
   * why it is a PUT. Exactly one row must be primary.
   */
  @Put('practitioners/:practitionerId/specialties')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Fijar las especialidades de un profesional' })
  @ApiOkResponse({ type: PractitionerSpecialtyListDto })
  async replaceSpecialties(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Body() dto: AssignSpecialtiesDto,
    @Req() req: Request,
  ): Promise<PractitionerSpecialtyListResponse> {
    const items = await this.assignments.replaceSpecialties(
      practitionerId,
      dto.items,
      this.requester(req),
    );
    return { items };
  }

  // --- Duration exceptions (ST-009) ------------------------------------------

  /** ST-009, resolved per row through the D-010 hierarchy. */
  @Get('practitioners/:practitionerId/duration-exceptions')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Duraciones de un profesional, ya resueltas' })
  @ApiOkResponse({ type: PractitionerDurationListDto })
  async listDurations(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
  ): Promise<PractitionerDurationListResponse> {
    const items = await this.assignments.listDurations(practitionerId);
    return { items };
  }

  /** ST-009. A PUT: setting it twice is the same exception, not two. */
  @Put('practitioners/:practitionerId/duration-exceptions/:serviceTypeId')
  @RequirePermission('staff:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Fijar una excepción de duración' })
  @ApiNoContentResponse()
  async setDurationException(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Param('serviceTypeId', ParseUUIDPipe) serviceTypeId: string,
    @Body() dto: SetDurationExceptionDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.assignments.setDurationException(
      practitionerId,
      serviceTypeId,
      dto.durationMinutes,
      this.requester(req),
    );
  }

  /** ST-009: back to the base duration. */
  @Delete('practitioners/:practitionerId/duration-exceptions/:serviceTypeId')
  @RequirePermission('staff:manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar una excepción de duración' })
  @ApiNoContentResponse()
  async removeDurationException(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Param('serviceTypeId', ParseUUIDPipe) serviceTypeId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.assignments.removeDurationException(
      practitionerId,
      serviceTypeId,
      this.requester(req),
    );
  }

  /** Who is asking, for the trail (ST-010). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
