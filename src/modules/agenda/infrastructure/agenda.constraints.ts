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

  // ── Lista de espera (E5, `agenda_waitlist_contact_trail`) ────────────────
  //
  // AG-060. El rango preferido invertido. El DTO lo rechaza antes con un
  // mensaje por campo; esto es para la escritura que no pasa por él —una
  // importación, un `psql`—, igual que los rangos de `site_parameter`.
  waitlist_entry_preferred_range_valid: {
    code: 'INVALID_PREFERRED_RANGE',
    field: 'preferredTo',
    message: 'La fecha final del rango no puede ser anterior a la inicial',
  },
  // AG-063. `SCHEDULED` sin cita enlazada, o cita enlazada sin `SCHEDULED`:
  // son el mismo hecho y el CHECK es bicondicional. Ningún camino de la
  // aplicación lo alcanza —`convertWaitlistEntry` escribe las dos columnas en
  // la misma sentencia—, y por eso está aquí: si algún día uno lo alcanza, el
  // mensaje dice qué pasó en vez de nombrar un constraint.
  waitlist_entry_conversion_complete: {
    code: 'WAITLIST_CONVERSION_INCOMPLETE',
    field: 'convertedEntryId',
    message:
      'Una inscripción atendida tiene que decir con qué cita se atendió: se marcan las dos cosas a la vez',
  },
});

/**
 * ⚠️ LOS DOS DISPARADORES DE E5 NO ESTÁN AQUÍ, Y NO ES UN OLVIDO.
 *
 * `trg_waitlist_entry_conversion_consented` y `trg_waitlist_entry_closure_final`
 * lanzan desde PL/pgSQL, así que PostgreSQL no emite ninguna cláusula
 * «violates check constraint "…"» y el nombre no viaja: llegan sólo por
 * SQLSTATE (`23514`), que este registro no puede leer. Se distinguen por la
 * frase que levanta cada uno, en `prisma-waitlist.repository.ts`, que es donde
 * `patients` resolvió lo mismo para los tres rechazos de la fusión.
 *
 * Tampoco está `waitlist_entry_one_per_converted_entry`: Prisma resuelve la
 * violación de unicidad ella misma (P2002) y devuelve la COLUMNA, no el nombre
 * del índice, así que este registro nunca lo encontraría.
 */
