import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { ScheduleRuleOutcome } from './application/schedule-rules.service';
import { ScheduleRulesService } from './application/schedule-rules.service';
import type { Requester } from './application/staff-audit.trail';
import {
  // NO `import type` for parameter DTOs: see staff.controller.ts.
  CreateScheduleRuleDto,
  ListScheduleRulesQueryDto,
  ScheduleRuleListDto,
  ScheduleRuleOutcomeDto,
  UpdateScheduleRuleDto,
  type ScheduleRuleListResponse,
  type ScheduleRuleOutcomeResponse,
} from './dto/staff.dto';

/**
 * Editing a practitioner's schedule from the application (S2, REQ-151).
 *
 * A SEPARATE CONTROLLER, same `staff` prefix. The file and the schedule are
 * administered from different screens and change for different reasons, and
 * one controller with twenty handlers is one nobody reads before adding the
 * twenty-first.
 *
 * THE SITE SCOPE IS `'global'` ON ALL OF THEM, and it is not laziness: guards
 * run BEFORE pipes, so the body is unvalidated when the site scope would be
 * checked, and the site of a schedule rule travels in the BODY, not in the
 * URL. What replaces it is stronger than a scope check would have been —
 * ST-007 refuses a rule in any site where the practitioner does not attend,
 * checked against the assignment table on every write.
 *
 * EVERY MUTATION ANSWERS WITH ITS CONFLICTS (ST-043). The appointments a
 * change leaves outside the new hours are LISTED and never touched: cancelling
 * or moving them automatically would turn one administrative edit into ten
 * phone calls nobody made.
 */
@ApiTags('staff')
@Controller({ path: 'staff', version: '1' })
export class StaffScheduleController {
  constructor(
    private readonly schedule: ScheduleRulesService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** ST-040, ST-041. */
  @Get('practitioners/:practitionerId/schedule-rules')
  @RequirePermission('staff:read', 'global')
  @ApiOperation({ summary: 'Reglas de horario de un profesional' })
  @ApiOkResponse({ type: ScheduleRuleListDto })
  async list(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Query() query: ListScheduleRulesQueryDto,
  ): Promise<ScheduleRuleListResponse> {
    const items = await this.schedule.list(practitionerId, query.includeClosed);
    return { items };
  }

  /** ST-040, ST-042, ST-045, ST-046. */
  @Post('practitioners/:practitionerId/schedule-rules')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Crear una regla de horario con vigencia' })
  @ApiCreatedResponse({ type: ScheduleRuleOutcomeDto })
  async create(
    @Param('practitionerId', ParseUUIDPipe) practitionerId: string,
    @Body() dto: CreateScheduleRuleDto,
    @Req() req: Request,
  ): Promise<ScheduleRuleOutcomeResponse> {
    return toResponse(
      await this.schedule.create(
        practitionerId,
        {
          siteId: dto.siteId,
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          slotMinutes: dto.slotMinutes,
          validFrom: dto.validFrom,
          validTo: dto.validTo ?? null,
        },
        this.requester(req),
      ),
    );
  }

  /** ST-040, ST-042, ST-044. */
  @Patch('schedule-rules/:ruleId')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Editar una regla de horario' })
  @ApiOkResponse({ type: ScheduleRuleOutcomeDto })
  async update(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateScheduleRuleDto,
    @Req() req: Request,
  ): Promise<ScheduleRuleOutcomeResponse> {
    return toResponse(
      await this.schedule.update(
        ruleId,
        {
          siteId: dto.siteId,
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          slotMinutes: dto.slotMinutes,
          validFrom: dto.validFrom,
          validTo: dto.validTo,
        },
        this.requester(req),
      ),
    );
  }

  /**
   * ST-041. A DELETE that closes and never deletes: the validity is ended
   * FORWARD, the days already past keep the rule that justified their
   * appointments, and the row survives so last month's agenda stays
   * explainable.
   *
   * It answers 200 with a body and not 204 because the conflicts of ST-043 are
   * the whole point of closing a schedule from a screen.
   */
  @Delete('schedule-rules/:ruleId')
  @RequirePermission('staff:manage', 'global')
  @ApiOperation({ summary: 'Cerrar una regla de horario hacia adelante' })
  @ApiOkResponse({ type: ScheduleRuleOutcomeDto })
  async close(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Req() req: Request,
  ): Promise<ScheduleRuleOutcomeResponse> {
    return toResponse(await this.schedule.close(ruleId, this.requester(req)));
  }

  /** Who is asking, for the trail (ST-044). */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/**
 * Instants as ISO strings with their offset, which is what the response schema
 * publishes and what `clinica-web` generates its types from. Serialising a
 * `Date` by accident would work today and stop the day the transport changes.
 */
function toResponse(outcome: ScheduleRuleOutcome): ScheduleRuleOutcomeResponse {
  return {
    rule: outcome.rule,
    conflicts: outcome.conflicts.map((conflict) => ({
      agendaEntryId: conflict.agendaEntryId,
      siteId: conflict.siteId,
      date: conflict.date,
      startsAt: conflict.startsAt.toISOString(),
      endsAt: conflict.endsAt.toISOString(),
    })),
  };
}
