/**
 * AG-050, AG-162, AG-164, AG-132 (D-127). What an edit of an agenda entry may
 * change, judged on the row as it is inside the adapter's transaction.
 *
 * PURE, like the status machine: the instant and the author enter as
 * parameters. The adapter stamps the edit and `trg_agenda_entry_record_version`
 * archives the previous row in the same statement, so nothing here has to
 * remember what was there before.
 *
 * WHAT IS NOT JUDGED HERE: whether the new interval is bookable. The service
 * runs the same checks a booking gets before the transaction opens
 * (`checkIntervalIsBookable`), and the `EXCLUDE` constraints arbitrate the
 * overlap at write time.
 */

import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotEditableError,
  EmergencyCorrectionNeedsClinicalPermissionError,
  AgendaEntryNotFoundError,
  AppointmentFromWaitlistError,
} from './agenda.errors';
import type { AgendaEntryStatus } from './agenda-entry';
import type { EditRead, EntryEdit } from './agenda.repository';

/**
 * AG-162. Where the hour, the practitioner, the type, the channel and the
 * patient can still change: before the patient arrives.
 */
const MOVABLE: readonly AgendaEntryStatus[] = ['BOOKED', 'CONFIRMED'];

/**
 * AG-162. Where the motive of the visit and the room can still be corrected:
 * also while the patient is in the building.
 */
const ANNOTATABLE: readonly AgendaEntryStatus[] = [
  ...MOVABLE,
  'CHECKED_IN',
  'IN_PROGRESS',
];

/** AG-132. Where the emergency call is corrected by whoever records arrivals. */
const EMERGENCY_CORRECTABLE: readonly AgendaEntryStatus[] = [
  'CHECKED_IN',
  'IN_PROGRESS',
];

/**
 * AG-174 (D-141.5). After the stay: the patient was here and is gone. A
 * `CANCELLED` row only counts if the arrival was recorded, which the caller
 * already demands (no call, nothing to correct).
 */
const AFTER_THE_STAY: readonly AgendaEntryStatus[] = [
  'FULFILLED',
  'LEFT_WITHOUT_BEING_SEEN',
  'CANCELLED',
];

/** The fields of an appointment edit that move it or change whose it is. */
const MOVING_FIELDS = [
  'startsAt',
  'endsAt',
  'practitionerId',
  'serviceTypeId',
  'bookingChannel',
  'patientId',
] as const satisfies readonly (keyof EntryEdit)[];

/** Whether the edit moves the appointment or changes its patient. */
export function editMoves(edit: EntryEdit): boolean {
  return MOVING_FIELDS.some((field) => edit[field] !== undefined);
}

/**
 * AG-162 (review, P1). Whether the edit puts the appointment at ANOTHER hour
 * or with ANOTHER practitioner — the only edits a booking's window, lead time
 * and schedule judge. Correcting the patient, the channel or the type of an
 * appointment that keeps its hour is not a new booking: refusing it because
 * the hour already started would leave the attention on the wrong chart.
 */
export function editRelocates(edit: EntryEdit): boolean {
  return (
    edit.startsAt !== undefined ||
    edit.endsAt !== undefined ||
    edit.practitionerId !== undefined
  );
}

/**
 * AG-050, AG-162. Judges an edit of an APPOINTMENT and returns what to write.
 *
 * A moved overbooking becomes ordinary (`clearOverbooking`): the service has
 * already checked that it fits the grid, exactly as the reschedule did.
 */
export function planEntryEdit(entry: EditRead, edit: EntryEdit): EntryEdit {
  // AG-071: a block is not addressed by `entries/:id`. Telling it apart here
  // would turn the route into an oracle of identifiers.
  if (entry.kind !== 'APPOINTMENT') throw new AgendaEntryNotFoundError();

  const moves = editMoves(edit);
  const allowed = moves ? MOVABLE : ANNOTATABLE;
  if (!allowed.includes(entry.status) || entry.releasedAt !== null) {
    throw new AgendaEntryNotEditableError(entry.status);
  }

  // AG-045. A documented attention outweighs the agenda: moving it would
  // deny a record that already exists.
  if (moves && entry.hasEncounter) throw new AgendaEntryHasEncounterError();

  // AG-063 (review, P1). The slot was given to the patient who waited for it;
  // handing it to somebody else would leave her holding nothing. The base
  // says it again (`trg_agenda_entry_waitlist_patient_fixed`).
  if (edit.patientId !== undefined && entry.fromWaitlist) {
    throw new AppointmentFromWaitlistError();
  }

  return edit;
}

/**
 * AG-164. Judges an edit of a BLOCK: its hour, its room or its reason, while
 * it still closes the calendar. Whether appointments stand inside the new
 * interval was read by the service (AG-038); the `EXCLUDE` decides the rest.
 */
export function planBlockEdit(entry: EditRead, edit: EntryEdit): EntryEdit {
  if (entry.kind !== 'BLOCK') throw new AgendaEntryNotFoundError();
  if (entry.status !== 'BLOCKED' || entry.releasedAt !== null) {
    throw new AgendaEntryNotEditableError(entry.status);
  }
  return {
    startsAt: edit.startsAt,
    endsAt: edit.endsAt,
    roomId: edit.roomId,
    reason: edit.reason,
  };
}

/** AG-132. The correction of the emergency call made at the arrival. */
export interface EmergencyCorrection {
  emergency: boolean;
  note: string | undefined;
  correctedById: string;
  now: Date;
  /** AG-174. The corrector holds `record:write` at this site. */
  mayWriteRecord: boolean;
}

/**
 * AG-132, D-128.4. Corrects the outcome of the emergency call already made.
 *
 * THE CALL AT THE ARRIVAL STAYS ON THE ROW: `emergency_assessed_at` and its
 * author are the art. 10 record of the arrival and do not move. Who corrected
 * and when is the edit stamp (`edited_by_id`, `edited_at`), and the previous
 * outcome is the version.
 *
 * ONLY A CALL THAT EXISTS, AND WHILE THE PATIENT IS IN THE BUILDING
 * (`CHECKED_IN`, `IN_PROGRESS`). After that, D-141.5.
 */
export function planEmergencyCorrection(
  entry: EditRead,
  correction: EmergencyCorrection,
): EntryEdit {
  if (entry.kind !== 'APPOINTMENT') throw new AgendaEntryNotFoundError();
  const afterTheStay = AFTER_THE_STAY.includes(entry.status);
  if (
    entry.emergencyAssessedAt === null ||
    entry.emergencyAssessedById === null ||
    (!EMERGENCY_CORRECTABLE.includes(entry.status) && !afterTheStay)
  ) {
    throw new AgendaEntryNotEditableError(entry.status);
  }
  if (afterTheStay && !correction.mayWriteRecord) {
    throw new EmergencyCorrectionNeedsClinicalPermissionError();
  }
  const note = correction.note?.trim() || null;
  return {
    emergency: {
      assessedAt: entry.emergencyAssessedAt,
      assessedById: entry.emergencyAssessedById,
      flaggedAt: correction.emergency ? correction.now : null,
      flaggedById: correction.emergency ? correction.correctedById : null,
      note: correction.emergency ? note : null,
    },
  };
}
