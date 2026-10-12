import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { LiveEventBus } from '../../../shared/events/live-event-bus';

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
    /** AG-182. Where «you have a notice» is said, to its recipient only. */
    private readonly liveEvents: LiveEventBus,
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
    const acknowledged = await this.alerts.acknowledge(
      alertId,
      recipientId,
      new Date(),
    );
    if (acknowledged === null) throw new EmergencyAlertNotFoundError();
    // AG-182. The recipient's other tabs and sessions drop the banner too.
    this.liveEvents.publish({
      kind: 'emergency-alerts',
      siteId: acknowledged.siteId,
      userIds: [recipientId],
    });
    // AG-183. The site's boards read again: the in-person mark may be gone.
    // Only the site and the kind, like every `agenda` event (AU-055).
    this.liveEvents.publish({ kind: 'agenda', siteId: acknowledged.siteId });

    // AG-074. Stable codes only: whose emergency it was is health data.
    this.logger.info(
      { action: 'AGENDA_EMERGENCY_ALERT_ACKNOWLEDGED' },
      'emergency alert acknowledged',
    );
    return acknowledged.acknowledgedAt;
  }

  /**
   * AG-182. After an arrival called an emergency (AG-129) or its correction
   * (AG-132) committed: each recipient still unaware hears that they have a
   * notice —never whose or why (AU-055)— and reads `mine` again. Never
   * throws: the arrival is saved, and the banner still has its polling.
   */
  async announcePendingOf(agendaEntryId: string): Promise<void> {
    try {
      const pending = await this.alerts.pendingRecipientsOfEntry(agendaEntryId);
      const bySite = new Map<string, string[]>();
      for (const { siteId, recipientId } of pending) {
        bySite.set(siteId, [...(bySite.get(siteId) ?? []), recipientId]);
      }
      for (const [siteId, userIds] of bySite) {
        this.liveEvents.publish({ kind: 'emergency-alerts', siteId, userIds });
      }
    } catch {
      // Nothing to undo: the event is a courtesy to the open screens.
    }
  }
}
