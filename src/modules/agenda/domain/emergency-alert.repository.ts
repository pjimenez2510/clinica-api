/**
 * AG-129, AG-175. The notices of an emergency arrival, as their recipient
 * reads and acknowledges them.
 *
 * A PORT OF ITS OWN and not more methods on `AgendaRepository`: the notices
 * are read by whoever receives them, across sites and on every screen, and
 * acknowledged by them alone — none of which is booking. They are WRITTEN by
 * the agenda's port, in the transaction of the call (AG-129), because that is
 * the only place the «same transaction» can be honoured.
 */
export const EMERGENCY_ALERT_REPOSITORY = Symbol('EMERGENCY_ALERT_REPOSITORY');

/** One pending notice, as the recipient's banner shows it. */
export interface PendingEmergencyAlert {
  id: string;
  agendaEntryId: string;
  siteId: string;
  siteName: string;
  /** Ecuadorian filing order, surname first, like every agenda listing. */
  patientName: string;
  startsAt: Date;
  alertedAt: Date;
  raisedByName: string;
}

export interface EmergencyAlertRepository {
  /**
   * The recipient's notices not yet acknowledged, oldest first, at any site:
   * they are addressed to the account, whatever its grants.
   */
  pendingFor(recipientId: string): Promise<PendingEmergencyAlert[]>;
  /**
   * Stamps «Enterado» once. Answers the instant stored — the one already
   * there if it was acknowledged before — or `null` when no notice with that
   * id is addressed to this recipient.
   */
  acknowledge(
    alertId: string,
    recipientId: string,
    at: Date,
  ): Promise<Date | null>;
}
