import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { ClinicalDate } from '../../shared/domain/clinic-time';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  type AssessedPriorityGroup,
  PatientPriorityService,
} from './application/patient-priority.service';
import type { Requester } from './application/patients.service';
import {
  ClosePriorityGroupDto,
  PriorityGroupDto,
  PriorityGroupListDto,
  RecordPriorityGroupDto,
  type PriorityGroupListResponse,
  type PriorityGroupResponse,
} from './dto/patient.dto';

/**
 * Why a patient is prioritised (PA-033 to PA-042, REQ-024, D-026, D-027).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CONTROLLER APART, BECAUSE THE DOOR IS APART
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every route here demands `patient:priority`, which `patient:read` does not
 * imply and which D-029 gives to `MEDICO` and `ENFERMERIA` only. Reception and
 * billing hold `patient:read` and keep working: the ORDER travels on every
 * patient they already receive (PA-041), and the reason does not (PA-042).
 * That split is the whole delivery, and putting these handlers next to the
 * register's would make it one forgotten decorator away from disappearing.
 *
 * `siteScope: 'global'` for the same reason as the register: a person is one
 * chart in the whole clinic, not one per branch (PA-051).
 *
 * THE SECOND LEVEL OF D-027 IS NOT HERE. Whether the caller may see the
 * restricted groups depends on the ROW, not on the endpoint, and a route
 * declares one permission — so `PatientPriorityService` enforces it, and names
 * `patient:priority:protected` in one place.
 */
@ApiTags('patients')
@Controller({ path: 'patients/:id/priority-groups', version: '1' })
export class PatientPriorityController {
  constructor(
    private readonly priority: PatientPriorityService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  @RequirePermission('patient:priority', 'global')
  @ApiOperation({ summary: 'Read why a patient is prioritised' })
  @ApiOkResponse({ type: PriorityGroupListDto })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<PriorityGroupListResponse> {
    const { asOf, records } = await this.priority.list(
      id,
      this.requester(req),
      this.currentUser.requirePrincipal(),
    );

    return { asOf, items: records.map(toResponse) };
  }

  @Post()
  @RequirePermission('patient:priority', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a priority group assessment' })
  @ApiCreatedResponse({ type: PriorityGroupDto })
  async record(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPriorityGroupDto,
    @Req() req: Request,
  ): Promise<PriorityGroupResponse> {
    const created = await this.priority.record(
      {
        patientId: id,
        group: dto.group,
        startsOn: dto.startsOn as ClinicalDate,
        endsOn: (dto.endsOn ?? null) as ClinicalDate | null,
        origin: dto.origin,
        evidenceDocument: dto.evidenceDocument ?? null,
      },
      this.requester(req),
      this.currentUser.requirePrincipal(),
    );

    return toResponse(created);
  }

  /**
   * Closes an assessment: sets the day it stopped applying.
   *
   * `PATCH` and not `DELETE`, and that is PA-037 in the verb: closing a state
   * must not remove the row, or «¿por qué esta persona tuvo prioridad en
   * marzo?» loses its answer. There is no route that deletes one.
   */
  @Patch(':recordId')
  @RequirePermission('patient:priority', 'global')
  @ApiOperation({ summary: 'Close a priority group assessment' })
  @ApiOkResponse({ type: PriorityGroupDto })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() dto: ClosePriorityGroupDto,
    @Req() req: Request,
  ): Promise<PriorityGroupResponse> {
    const closed = await this.priority.close(
      { patientId: id, recordId, endsOn: dto.endsOn as ClinicalDate },
      this.requester(req),
      this.currentUser.requirePrincipal(),
    );

    return toResponse(closed);
  }

  /** Who is asking, for the access trail. See `PatientsController`. */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/**
 * Periods leave as `YYYY-MM-DD`, instants as ISO 8601.
 *
 * Same rule as the birth date, and for the same reason: a period is a pair of
 * calendar dates, and serialising one as an instant moves it by a day for
 * everybody west of Greenwich — which is everybody here.
 */
function toResponse(record: AssessedPriorityGroup): PriorityGroupResponse {
  return {
    id: record.id,
    group: record.group,
    startsOn: record.startsOn,
    endsOn: record.endsOn,
    inForce: record.inForce,
    origin: record.origin,
    evidenceDocument: record.evidenceDocument,
    recordedById: record.recordedById,
    recordedAt: record.recordedAt.toISOString(),
    closedById: record.closedById,
    closedAt: record.closedAt?.toISOString() ?? null,
  };
}
