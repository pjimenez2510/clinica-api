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
 * THE THREE MUTATIONS DECLARE `'query'`, NOT `'global'` (ST-048, D-023). The
 * site of a schedule rule travels in the BODY — and on the DELETE it travels
 * in no request at all, it is in the row — and guards run BEFORE pipes, so
 * there is nothing validated for the guard to check at that moment. `global`
 * said «this route has no site dimension», which was false: whoever held
 * `staff:manage` at one site could open, move and close another site's
 * schedule, which is what makes that site's agenda offer slots. The handler
 * narrows instead, with the caller's own resolved scope.
 *
 * ST-007 IS A DIFFERENT QUESTION AND STAYS. «Does this practitioner attend
 * there?» is not «is that site the caller's?», and reading the first as an
 * answer to the second is what left the hole open for a whole delivery. The
 * listing stays `global`: reading a schedule opens no agenda.
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

  /** ST-040, ST-042, ST-045, ST-046, ST-048. */
  @Post('practitioners/:practitionerId/schedule-rules')
  @RequirePermission('staff:manage', 'query')
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
          validFrom: dto.validFrom,
          validTo: dto.validTo ?? null,
        },
        this.requester(req),
        // ST-048: the scope comes from the session the guard resolved, never
        // from the request — a body that could widen it would be no check.
        this.currentUser.requirePrincipal(),
      ),
    );
  }

  /** ST-040, ST-042, ST-044, ST-048. */
  @Patch('schedule-rules/:ruleId')
  @RequirePermission('staff:manage', 'query')
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
          validFrom: dto.validFrom,
          validTo: dto.validTo,
        },
        this.requester(req),
        this.currentUser.requirePrincipal(),
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
  @RequirePermission('staff:manage', 'query')
  @ApiOperation({ summary: 'Cerrar una regla de horario hacia adelante' })
  @ApiOkResponse({ type: ScheduleRuleOutcomeDto })
  async close(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Req() req: Request,
  ): Promise<ScheduleRuleOutcomeResponse> {
    return toResponse(
      await this.schedule.close(
        ruleId,
        this.requester(req),
        this.currentUser.requirePrincipal(),
      ),
    );
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
