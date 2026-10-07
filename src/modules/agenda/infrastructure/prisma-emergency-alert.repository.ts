import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  EmergencyAlertRepository,
  PendingEmergencyAlert,
} from '../domain/emergency-alert.repository';

/** AG-175. The recipient's notices, read and acknowledged. */
@Injectable()
export class PrismaEmergencyAlertRepository implements EmergencyAlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * NOT narrowed by site: the notice is addressed to this account, and a
   * doctor seeing patients at a site where their role was not granted would
   * otherwise never see the emergency that was sent to them.
   */
  async pendingFor(recipientId: string): Promise<PendingEmergencyAlert[]> {
    // `agenda_emergency_alert_pending_by_recipient` is exactly this predicate.
    const rows = await this.prisma.agendaEmergencyAlert.findMany({
      where: {
        recipientId,
        acknowledgedAt: null,
      },
      orderBy: { alertedAt: 'asc' },
      select: {
        id: true,
        agendaEntryId: true,
        siteId: true,
        alertedAt: true,
        site: { select: { name: true } },
        raisedBy: { select: { firstName: true, lastName: true } },
        agendaEntry: {
          select: {
            startsAt: true,
            patient: { select: { givenName: true, familyName: true } },
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      agendaEntryId: row.agendaEntryId,
      siteId: row.siteId,
      siteName: row.site.name,
      patientName: row.agendaEntry.patient
        ? `${row.agendaEntry.patient.familyName}, ${row.agendaEntry.patient.givenName}`
        : '',
      startsAt: row.agendaEntry.startsAt,
      alertedAt: row.alertedAt,
      raisedByName: `${row.raisedBy.firstName} ${row.raisedBy.lastName}`.trim(),
    }));
  }

  /**
   * Conditioned on the recipient AND on not being acknowledged yet: the
   * trigger refuses a second stamp, and asking first would race. A second
   * «Enterado» answers the first instant, which is what is stored.
   */
  async acknowledge(
    alertId: string,
    recipientId: string,
    at: Date,
  ): Promise<Date | null> {
    await this.prisma.agendaEmergencyAlert.updateMany({
      where: { id: alertId, recipientId, acknowledgedAt: null },
      data: { acknowledgedAt: at },
    });
    const row = await this.prisma.agendaEmergencyAlert.findFirst({
      where: { id: alertId, recipientId },
      select: { acknowledgedAt: true },
    });
    return row?.acknowledgedAt ?? null;
  }
}
