import type { AgendaEntryView } from './domain/agenda.repository';
import { arrivalDelayMinutes } from './domain/late-arrival';
import type { AgendaEntryResponse } from './dto/agenda.dto';

/**
 * One entry as every agenda listing serves it — the day's agenda, a booking,
 * a transition, and each row of the staff board (AG-134), which is why it
 * lives apart from any one controller.
 */
/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
export function toEntryResponse(entry: AgendaEntryView): AgendaEntryResponse {
  return {
    id: entry.id,
    kind: entry.kind,
    siteId: entry.siteId,
    practitionerId: entry.practitionerId,
    roomId: entry.roomId,
    patientId: entry.patientId,
    patientName: entry.patientName,
    startsAt: entry.startsAt.toISOString(),
    endsAt: entry.endsAt.toISOString(),
    status: entry.status,
    blocksCalendar: entry.blocksCalendar,
    // AG-036: the reason of the exception and who authorised it, on every row.
    // NOT `reason`, which is the motive for the visit and stays out (AG-072).
    overbookingReason: entry.overbookingReason,
    overbookingAuthorisedById: entry.overbookingAuthorisedById,
    // AG-018: what tells a released entry apart from a live one.
    releasedAt: entry.releasedAt?.toISOString() ?? null,
    // AG-041, AG-118. The instant, and the subtraction that is computed here
    // and stored nowhere — which is what keeps late arrival from becoming a
    // status. The sign is kept: negative means the patient came early.
    checkedInAt: entry.checkedInAt?.toISOString() ?? null,
    arrivalDelayMinutes: arrivalDelayMinutes(entry),
    // AG-121. The patient axis, separate from the appointment's.
    subjectStatus: entry.subjectStatus,
    subjectStatusAt: entry.subjectStatusAt?.toISOString() ?? null,
    // AG-128. The act, and its outcome. Never the note (AG-074).
    emergencyAssessedAt: entry.emergencyAssessedAt?.toISOString() ?? null,
    emergencyFlaggedAt: entry.emergencyFlaggedAt?.toISOString() ?? null,
    bookingChannel: entry.bookingChannel,
    serviceId: entry.serviceId,
    createdById: entry.createdById,
    // AG-051: both ends of the reschedule chain, so neither entry has to be
    // looked up to find out what happened to the other.
    rescheduledFromId: entry.rescheduledFromId,
    rescheduledToId: entry.rescheduledToId,
    // AG-150: the state of its live attention, never its identifier.
    attention: entry.attention,
    // AG-120: who let it in past the threshold.
    lateAdmission: entry.lateAdmission
      ? {
          byName: entry.lateAdmission.byName,
          at: entry.lateAdmission.at.toISOString(),
        }
      : null,
    // AG-173: moved to today by an emergency, which is not an overbooking.
    emergencyMovedAt: entry.emergencyMovedAt?.toISOString() ?? null,
    // AG-129: whom the emergency call notified.
    emergencyAlerts: entry.emergencyAlerts.map((alert) => ({
      recipientName: alert.recipientName,
      alertedAt: alert.alertedAt.toISOString(),
      acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
      onDuty: alert.onDuty,
    })),
  };
}
