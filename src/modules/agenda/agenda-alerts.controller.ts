import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { EmergencyAlertService } from './application/emergency-alert.service';
import {
  EmergencyAlertAcknowledgementDto,
  type EmergencyAlertAcknowledgementResponse,
  PendingEmergencyAlertsDto,
  type PendingEmergencyAlertsResponse,
} from './dto/agenda.dto';

/**
 * AG-129, AG-175. The emergency notices, from the side of whoever receives
 * them.
 *
 * `agenda:read` AND NOT A PERMISSION OF ITS OWN (AG-130): every schedulable
 * professional holds it, and a permission nobody is granted would be a notice
 * nobody receives. `'query'` site scope: the handler narrows to the
 * session's own notices, whichever site they come from.
 */
@ApiTags('agenda')
@Controller({ path: 'agenda/emergency-alerts', version: '1' })
export class AgendaAlertsController {
  constructor(
    private readonly alerts: EmergencyAlertService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** AG-175. What is pending for the session, oldest first. */
  @Get('mine')
  @RequirePermission('agenda:read', 'query')
  @ApiOperation({ summary: 'Avisos de emergencia pendientes para mí' })
  @ApiOkResponse({ type: PendingEmergencyAlertsDto })
  async mine(): Promise<PendingEmergencyAlertsResponse> {
    // The session's own notices, at any site: they were addressed to it
    // (clinical review, G1). The `'query'` scope is that narrowing.
    const items = await this.alerts.pendingFor(
      this.currentUser.requireUserId(),
    );
    return {
      items: items.map((item) => ({
        id: item.id,
        agendaEntryId: item.agendaEntryId,
        siteId: item.siteId,
        siteName: item.siteName,
        patientName: item.patientName,
        startsAt: item.startsAt.toISOString(),
        alertedAt: item.alertedAt.toISOString(),
        raisedByName: item.raisedByName,
      })),
    };
  }

  /** AG-175. «Enterado», by its recipient and nobody else. */
  @Post(':alertId/acknowledgement')
  @RequirePermission('agenda:read', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar «Enterado» un aviso de emergencia' })
  @ApiOkResponse({ type: EmergencyAlertAcknowledgementDto })
  async acknowledge(
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ): Promise<EmergencyAlertAcknowledgementResponse> {
    const at = await this.alerts.acknowledge(
      alertId,
      this.currentUser.requireUserId(),
    );
    return { id: alertId, acknowledgedAt: at.toISOString() };
  }
}
