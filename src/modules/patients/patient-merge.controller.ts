import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { PatientMergeService } from './application/patient-merge.service';
import type { Requester } from './application/patients.service';
import type { PatientMergeEvent } from './domain/patient.repository';
import {
  MergePatientDto,
  PatientMergeDto,
  UndoPatientMergeDto,
  type PatientMergeResponse,
} from './dto/patient.dto';

/**
 * Resolving duplicates: two charts of one person become one, reversibly
 * (PA-043 to PA-049, PA-052, REQ-010).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CONTROLLER APART, BECAUSE THE KEY IS APART (PA-052, D-030)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every route here demands `patient:merge`, which NO SHIPPED ROLE CARRIES — the
 * installation grants it to somebody on purpose or nobody holds it, exactly
 * like `agenda:overbook:self` and `user:reset-mfa`. A merge done on two
 * different people joins their clinical records, which is the worst incident
 * this module can produce, and undoing it can be impossible (PA-048). Putting
 * these two handlers next to the register's would leave that separation one
 * forgotten decorator away from disappearing.
 *
 * `siteScope: 'global'` like the rest of the module (PA-051): a person is one
 * chart in the whole clinic, not one per branch — which is the very duplicate
 * the MRN exists to prevent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE URL NAMES THE ABSORBED CHART, AND WHY BOTH ARE `POST`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `:id` is the chart that LOSES: it is the row that changes — it gains the
 * link and the instant — and it stays addressable afterwards precisely because
 * it is not deleted (PA-043). The survivor travels in the body, where the form
 * puts it.
 *
 * `POST .../merge/undo` and not `DELETE .../merge`, for the same reason
 * `PATCH` closes a priority group instead of `DELETE` removing it: nothing is
 * deleted here. Undoing is a NEW row in an append-only log, with its own
 * author, instant and mandatory reason (PA-047) — and a `DELETE` carrying a
 * mandatory body to say why would describe the opposite of what happens.
 */
@ApiTags('patients')
@Controller({ path: 'patients/:id/merge', version: '1' })
export class PatientMergeController {
  constructor(
    private readonly merges: PatientMergeService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * Merges this chart into another (PA-043, PA-044, PA-046).
   *
   * `200` and not `201`: nothing is created that the caller could go and fetch
   * at a URL of its own — the merge is an event in a log, and what comes back
   * is the state of the two charts.
   */
  @Post()
  @RequirePermission('patient:merge', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Merge this chart into another one' })
  @ApiOkResponse({ type: PatientMergeDto })
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergePatientDto,
    @Req() req: Request,
  ): Promise<PatientMergeResponse> {
    const event = await this.merges.merge(
      {
        sourcePatientId: id,
        targetPatientId: dto.targetPatientId,
        reason: dto.reason,
      },
      this.requester(req),
    );

    return toResponse(event, event.restOverlapNotice);
  }

  /**
   * Undoes the merge of this chart (PA-047, PA-048).
   *
   * ⚠️ THE ONE ROUTE THAT MAY NAME A MERGED CHART. Everywhere else PA-045
   * refuses it with `PATIENT_MERGED`; here refusing would make the requirement
   * unreachable, because the chart to un-merge is merged by definition.
   */
  @Post('undo')
  @RequirePermission('patient:merge', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Undo the merge of this chart' })
  @ApiOkResponse({ type: PatientMergeDto })
  async undo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UndoPatientMergeDto,
    @Req() req: Request,
  ): Promise<PatientMergeResponse> {
    const event = await this.merges.undo(
      { sourcePatientId: id, reason: dto.reason },
      this.requester(req),
    );

    return toResponse(event);
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
 * The event as the API publishes it.
 *
 * ⚠️ WHAT DOES *NOT* TRAVEL: the reason, the snapshot and the author. The
 * reason and the snapshot hold chart contents — the whole point of storing them
 * is the audit trail, not the screen — and echoing the snapshot back would put
 * a copy of one patient's data in the response of an operation about another.
 * Two MRNs, two ids and an instant are what the interface needs to redirect.
 */
function toResponse(
  event: PatientMergeEvent,
  restOverlapNotice: string | null = null,
): PatientMergeResponse {
  return {
    // PA-062. Only a merge can join overlapping rests; an undo says nothing.
    restOverlapNotice,
    mergeId: event.mergeId,
    event: event.event,
    sourcePatientId: event.sourcePatientId,
    sourceMrn: event.sourceMrn,
    targetPatientId: event.targetPatientId,
    targetMrn: event.targetMrn,
    performedAt: event.performedAt.toISOString(),
    /**
     * PA-049, D-031. Se lee por el enlace: ninguna fila hija se mueve, y esto
     * es lo que lo hace comprobable desde fuera.
     */
    linkedRecords: {
      policy: 'READ_THROUGH_LINK',
      ...event.linkedRecords,
    },
  };
}
