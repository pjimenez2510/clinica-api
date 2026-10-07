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

import { ALL_SITES } from '../../shared/authorisation/principal';
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
 * nobody receives. `'query'` site scope: the notices are the session's own,
 * and the handler narrows them to the sites where it may read the agenda.
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
    const principal = this.currentUser.requirePrincipal();
    const scope = principal.sitesFor('agenda:read');
    const items = await this.alerts.pendingFor(
      principal.userId,
      scope === ALL_SITES ? 'all' : scope,
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
