import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { EmergencyAlertNotFoundError } from '../domain/agenda.errors';
import {
  EMERGENCY_ALERT_REPOSITORY,
  type EmergencyAlertRepository,
  type PendingEmergencyAlert,
} from '../domain/emergency-alert.repository';

/**
 * AG-175. The recipient's side of the emergency notice (AG-129): what is
 * pending for them, and «Enterado».
 *
 * A SERVICE OF ITS OWN (ADR-008 §2): it shares no method with booking and
 * changes for another reason — who receives an emergency is D-170.1, not a
 * rule of the agenda.
 */
@Injectable()
export class EmergencyAlertService {
  constructor(
    @Inject(EMERGENCY_ALERT_REPOSITORY)
    private readonly alerts: EmergencyAlertRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmergencyAlertService.name);
  }

  async pendingFor(recipientId: string): Promise<PendingEmergencyAlert[]> {
    return this.alerts.pendingFor(recipientId);
  }

  /**
   * Only its recipient acknowledges a notice: anybody else gets the same 404
   * as a notice that does not exist, so ids cannot be probed (AG-071).
   */
  async acknowledge(alertId: string, recipientId: string): Promise<Date> {
    // The application's clock, never PostgreSQL's: the screen compares it.
    const at = await this.alerts.acknowledge(alertId, recipientId, new Date());
    if (at === null) throw new EmergencyAlertNotFoundError();

    // AG-074. Stable codes only: whose emergency it was is health data.
    this.logger.info(
      { action: 'AGENDA_EMERGENCY_ALERT_ACKNOWLEDGED' },
      'emergency alert acknowledged',
    );
    return at;
  }
}
