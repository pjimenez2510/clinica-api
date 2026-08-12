import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each agenda constraint means to the receptionist who hit it.
 *
 * Lives HERE, beside the repository and two directories from the migrations
 * that create these constraints, so adding one is a change inside the module
 * that owns it — never an edit to a shared file. Imported for its side effect
 * by `agenda.module.ts`.
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 */
registerConstraintMeanings({
  agenda_entry_no_practitioner_overlap: {
    code: 'PRACTITIONER_SLOT_TAKEN',
    field: 'startsAt',
    message: 'El profesional ya tiene una cita en ese horario',
  },
  agenda_entry_no_room_overlap: {
    code: 'ROOM_SLOT_TAKEN',
    field: 'roomId',
    message: 'El consultorio ya está ocupado en ese horario',
  },
  // AG-030. No name, no medical record number, no practitioner: this text is
  // read by a receptionist who may not have access to the other appointment.
  agenda_entry_no_patient_overlap: {
    code: 'PATIENT_DOUBLE_BOOKED',
    field: 'patientId',
    message: 'El paciente ya tiene otra cita a esa hora: elija otro horario o anule la anterior', // prettier-ignore
  },
  agenda_entry_kind_status_coherence: {
    code: 'INVALID_STATUS_FOR_KIND',
    field: 'status',
    message: 'Ese estado no corresponde al tipo de entrada: «bloqueado» es solo para un bloqueo de agenda', // prettier-ignore
  },
  agenda_entry_booking_channel_coherence: {
    code: 'BOOKING_CHANNEL_REQUIRED',
    field: 'bookingChannel',
    message: 'Indique cómo se solicitó la cita: teléfono, ventanilla, web o referencia. Un bloqueo de agenda no lleva canal', // prettier-ignore
  },
  agenda_entry_time_order: {
    code: 'INVALID_TIME_RANGE',
    field: 'endsAt',
    message: 'La cita debe terminar después de la hora en que empieza',
  },
  agenda_entry_patient_coherence: {
    code: 'PATIENT_REQUIRED',
    field: 'patientId',
    message: 'Una cita necesita paciente y un bloqueo de agenda no lo admite',
  },
});
