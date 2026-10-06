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
  AgendaEntryNotFoundError,
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
}

/**
 * AG-132, D-128.4. Corrects the emergency call already made: the corrector
 * makes the call again, now; the original stays in `record_version`.
 *
 * ONLY A CALL THAT EXISTS IS CORRECTED. Making the first one is the arrival
 * (AG-128), and a correction route that could make it would be a second way
 * of registering an arrival without its history row.
 */
export function planEmergencyCorrection(
  entry: EditRead,
  correction: EmergencyCorrection,
): EntryEdit {
  if (entry.kind !== 'APPOINTMENT') throw new AgendaEntryNotFoundError();
  if (entry.emergencyAssessedAt === null) {
    throw new AgendaEntryNotEditableError(entry.status);
  }
  const note = correction.note?.trim() || null;
  return {
    emergency: {
      assessedAt: correction.now,
      assessedById: correction.correctedById,
      flaggedAt: correction.emergency ? correction.now : null,
      flaggedById: correction.emergency ? correction.correctedById : null,
      note: correction.emergency ? note : null,
    },
  };
}
