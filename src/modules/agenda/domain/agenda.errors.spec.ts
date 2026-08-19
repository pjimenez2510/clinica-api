import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  BusinessRuleViolation,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  BlockOverlapsAppointmentsError,
  BookingInThePastError,
  BookingRetryExhaustedError,
  BookingTooFarError,
  BookingTooSoonError,
  InvalidAgendaTransitionError,
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  NoShowBeforeStartError,
  OutsideScheduleRuleError,
  OverbookingLimitReachedError,
  OverbookingNotAllowedError,
  OverbookingNotAuthorisedError,
  OverbookingReasonRequiredError,
  ReleasedSlotInThePastError,
  SelfAuthorisationDeniedError,
  SlotNotAlignedError,
  SlotNotReleasedError,
  WaitlistAcceptanceRequiredError,
  WaitlistEntryClosedError,
  WaitlistEntryNotFoundError,
  WaitlistPatientMismatchError,
  WaitlistSlotAlreadyClaimedError,
} from './agenda.errors';
import { parseClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * The error contract: stable code, the category that decides the HTTP status,
 * and a sentence the user can act on. The status itself is asserted through
 * the category because the mapping lives in `problem-details.filter.ts`:
 * ValidationError and BusinessRuleViolation are both 422 there.
 */
describe('agenda errors', () => {
  it('AG-028 answers OUTSIDE_SCHEDULE_RULE as an unprocessable business rule', () => {
    const error = new OutsideScheduleRuleError();

    expect(error.code).toBe('OUTSIDE_SCHEDULE_RULE');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'El horario solicitado no está dentro de la agenda del profesional. Elija un cupo disponible',
    );
    expect(error.message).not.toMatch(/undefined/);
  });

  it('AG-034 answers INVALID_BOOKING_CHANNEL naming the field and the admitted values', () => {
    const error = new InvalidBookingChannelError();

    expect(error.code).toBe('INVALID_BOOKING_CHANNEL');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'Indique cómo se solicitó la cita: teléfono, ventanilla, web o referencia',
    );
    expect(error.fieldErrors?.[0]?.field).toBe('bookingChannel');
    expect(error.fieldErrors?.[0]?.code).toBe('INVALID_BOOKING_CHANNEL');
    expect(error.fieldErrors?.[0]?.message).toContain('PHONE');
  });

  it('AG-012 answers INVALID_SLOT_DURATION stating the admitted duration', () => {
    const error = new InvalidSlotDurationError(30, 20);

    expect(error.code).toBe('INVALID_SLOT_DURATION');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La duración de la cita no coincide con los cupos del profesional. Ajuste la hora de fin',
    );
    expect(error.params).toEqual({ requestedMinutes: 30, slotMinutes: 20 });
    expect(error.fieldErrors).toEqual([
      {
        field: 'endsAt',
        code: 'INVALID_SLOT_DURATION',
        message: 'La duración debe ser un múltiplo de 20 minutos',
      },
    ]);
  });

  it('AG-012 carries no patient data in the message that reaches the client', () => {
    const error = new InvalidSlotDurationError(30, 20);

    // `params` is interpolated into the response and ends up in support
    // screenshots: numbers only, never a name or a document.
    for (const value of Object.values(error.params)) {
      expect(typeof value).toBe('number');
    }
  });

  it('AG-104 answers SLOT_NOT_ALIGNED stating the nearest admitted starts', () => {
    const error = new SlotNotAlignedError(
      new Date('2026-09-14T13:10:00Z'), // 08:10 in Guayaquil
      {
        previous: new Date('2026-09-14T13:00:00Z'),
        next: new Date('2026-09-14T13:20:00Z'),
      },
    );

    expect(error.code).toBe('SLOT_NOT_ALIGNED');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La cita debe empezar al inicio de un cupo del profesional. Ajuste la hora de inicio',
    );
    expect(error.params).toEqual({
      requestedStart: '2026-09-14T13:10:00.000Z',
      previousStart: '2026-09-14T13:00:00.000Z',
      nextStart: '2026-09-14T13:20:00.000Z',
    });
    expect(error.fieldErrors).toEqual([
      {
        field: 'startsAt',
        code: 'SLOT_NOT_ALIGNED',
        message: 'Los inicios admitidos más próximos son 08:00 y 08:20',
      },
    ]);
  });

  it('AG-104 names only the start it has when the rule offers no neighbour on one side', () => {
    const error = new SlotNotAlignedError(new Date('2026-09-14T13:30:00Z'), {
      previous: new Date('2026-09-14T13:20:00Z'),
      next: null,
    });

    expect(error.params).toEqual({
      requestedStart: '2026-09-14T13:30:00.000Z',
      previousStart: '2026-09-14T13:20:00.000Z',
    });
    expect(error.fieldErrors?.[0]?.message).toBe(
      'El inicio admitido más próximo es 08:20',
    );
  });

  it('AG-104 carries only instants, never anything that identifies a patient', () => {
    const error = new SlotNotAlignedError(new Date('2026-09-14T13:10:00Z'), {
      previous: null,
      next: new Date('2026-09-14T13:20:00Z'),
    });

    for (const value of Object.values(error.params)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    expect(error.fieldErrors?.[0]?.message).toBe(
      'El inicio admitido más próximo es 08:20',
    );
  });

  it('AG-028 registers every new agenda code in the frozen public catalogue', () => {
    // `error-catalogue.spec.ts` fails from the other direction too; this one
    // states the intent where the codes are born.
    for (const code of [
      'INVALID_BOOKING_CHANNEL',
      'INVALID_SLOT_DURATION',
      'OUTSIDE_SCHEDULE_RULE',
      'SLOT_NOT_ALIGNED',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});

describe('the transition errors (E2)', () => {
  it('AG-040 answers INVALID_AGENDA_TRANSITION as a 409 naming the current state in Spanish', () => {
    const error = new InvalidAgendaTransitionError('CHECKED_IN', 'CONFIRMED');

    expect(error.code).toBe('INVALID_AGENDA_TRANSITION');
    expect(error).toBeInstanceOf(ConflictError); // 409, the spec names it
    expect(error.userTitle).toBe(
      'La cita está en estado «En sala» y no admite ese cambio. Actualice la agenda',
    );
    // Both ends in stable codes, for the client that branches.
    expect(error.params).toEqual({ from: 'CHECKED_IN', to: 'CONFIRMED' });
    expect(error.message).not.toMatch(/undefined/);
  });

  it('AG-045 answers AGENDA_ENTRY_HAS_ENCOUNTER as a 409 with the sentence of the spec', () => {
    const error = new AgendaEntryHasEncounterError();

    expect(error.code).toBe('AGENDA_ENTRY_HAS_ENCOUNTER');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'La cita ya tiene una atención registrada: no puede anularse ni marcarse como inasistencia',
    );
  });

  it('AG-043 answers NO_SHOW_BEFORE_START as an unprocessable business rule', () => {
    const error = new NoShowBeforeStartError();

    expect(error.code).toBe('NO_SHOW_BEFORE_START');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La inasistencia solo puede marcarse desde la hora de inicio de la cita',
    );
    // The message reaches the logs: no instant, no identifier.
    expect(error.params).toEqual({});
  });

  it('AG-071 answers AGENDA_ENTRY_NOT_FOUND alike for a missing entry and a foreign-site one', () => {
    const error = new AgendaEntryNotFoundError();

    expect(error.code).toBe('AGENDA_ENTRY_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
    // One message for both cases: "it exists, elsewhere" would confirm
    // entries of sites the caller has no scope over.
    expect(error.userTitle).toBe(
      'La cita no existe en esta sede. Actualice la agenda',
    );
  });

  it('AG-040 registers the four transition codes in the frozen public catalogue', () => {
    for (const code of [
      'INVALID_AGENDA_TRANSITION',
      'AGENDA_ENTRY_HAS_ENCOUNTER',
      'NO_SHOW_BEFORE_START',
      'AGENDA_ENTRY_NOT_FOUND',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});

describe('BookingRetryExhaustedError (AG-026)', () => {
  it('AG-026 is retryable, carries Retry-After and never names the patient or the hour', () => {
    const error = new BookingRetryExhaustedError(3);

    expect(error.code).toBe('BOOKING_RETRY_EXHAUSTED');
    expect(error.isRetryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(2);
    // This message DOES reach the logs: an attempt count is all it may carry.
    expect(error.message).toBe(
      'Booking abandoned after 3 serialisation failures',
    );
    expect(error.userTitle).toContain('Intente reservar de nuevo');
  });

  it('AG-026 lets the caller shorten or stretch the advised wait', () => {
    expect(new BookingRetryExhaustedError(5, 7).retryAfterSeconds).toBe(7);
  });
});

describe('SlotNotAlignedError wording (AG-104)', () => {
  it('speaks a whole sentence when no admitted start exists at all', () => {
    // Reachable only if the rule yields no slot; the sentence must still be
    // complete rather than have a hole where the clock would go.
    const error = new SlotNotAlignedError(new Date('2026-09-14T13:30:00Z'), {
      previous: null,
      next: null,
    });

    // The empty-neighbours sentence goes to the FIELD error, where the client
    // shows it beside `startsAt`; the title stays the generic instruction.
    expect(error.fieldErrors?.[0]?.message).toBe(
      'La cita debe empezar al inicio de un cupo del horario',
    );
  });
});

/**
 * The booking window of the site (E7). Same contract as every other error:
 * stable `code`, the category that decides the 422 in
 * `problem-details.filter.ts`, and a sentence that says what to do next.
 */
describe('the booking window errors (AG-031 to AG-033)', () => {
  it('AG-031 answers BOOKING_IN_THE_PAST without naming any instant', () => {
    const error = new BookingInThePastError();

    expect(error.code).toBe('BOOKING_IN_THE_PAST');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La cita no puede empezar en una hora que ya pasó. Elija una hora futura',
    );
    // Nothing to state that the caller does not know: they sent the start and
    // «now» is on their own screen.
    expect(error.params).toEqual({});
    expect(error.fieldErrors).toEqual([
      {
        field: 'startsAt',
        code: 'BOOKING_IN_THE_PAST',
        message: 'La hora indicada ya pasó',
      },
    ]);
  });

  it('AG-032 answers BOOKING_TOO_SOON stating the first admissible instant', () => {
    // 14:00Z is 09:00 in Guayaquil, and that is what the sentence must say:
    // «a las 14:00» would be a UTC timestamp leaking into Spanish.
    const error = new BookingTooSoonError(new Date('2026-09-14T14:00:00Z'), 60);

    expect(error.code).toBe('BOOKING_TOO_SOON');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La cita se pide con menos antelación de la que admite esta sede. Elija una hora más tarde',
    );
    expect(error.params).toEqual({
      earliestStart: '2026-09-14T14:00:00.000Z',
      minLeadMinutes: 60,
    });
    expect(error.fieldErrors).toEqual([
      {
        field: 'startsAt',
        code: 'BOOKING_TOO_SOON',
        message:
          'La primera cita que puede reservarse es el 14/09/2026 a las 09:00',
      },
    ]);
    // The technical half feeds the logs: minutes of configuration, never a
    // patient, a practitioner or a chart number.
    expect(error.message).toBe(
      'Requested start is closer than the 60 minute minimum lead of the site',
    );
  });

  it('AG-033 answers BOOKING_TOO_FAR stating the last admissible date', () => {
    const error = new BookingTooFarError(parseClinicalDate('2027-03-13'), 180);

    expect(error.code).toBe('BOOKING_TOO_FAR');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La cita se pide con demasiada antelación para esta sede. Elija una fecha más cercana',
    );
    // ISO in `params`, what the client parses; Ecuadorian order in the
    // sentence, what a person reads.
    expect(error.params).toEqual({
      latestDate: '2027-03-13',
      maxLeadDays: 180,
    });
    expect(error.fieldErrors?.[0]?.message).toBe(
      'La última fecha que puede reservarse es el 13/03/2027',
    );
  });

  it('AG-094 registers the three window codes in the frozen public catalogue', () => {
    for (const code of [
      'BOOKING_IN_THE_PAST',
      'BOOKING_TOO_SOON',
      'BOOKING_TOO_FAR',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });

  /* ─── E4: el sobrecupo y el bloqueo ─────────────────────────────────── */

  it('AG-039 answers OVERBOOKING_NOT_ALLOWED without blaming a field', () => {
    const error = new OverbookingNotAllowedError();

    expect(error.code).toBe('OVERBOOKING_NOT_ALLOWED');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'Esta sede no admite sobrecupos. Busque un cupo libre o pida que se habilite el sobrecupo para la sede',
    );
    // Nada del formulario está mal: lo que rechaza es un parámetro de sede, y
    // señalar una casilla mandaría a recepción a corregir lo que ya está bien.
    expect(error.fieldErrors).toBeUndefined();
  });

  it('AG-035 answers OVERBOOKING_REASON_REQUIRED on the field that is missing', () => {
    const error = new OverbookingReasonRequiredError();

    expect(error.code).toBe('OVERBOOKING_REASON_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.fieldErrors?.[0]?.field).toBe('overbookingReason');
    expect(error.fieldErrors?.[0]?.message).toBe(
      'Indique el motivo del sobrecupo',
    );
  });

  it('AG-103 answers SELF_AUTHORISATION_DENIED telling whom to ask', () => {
    const error = new SelfAuthorisationDeniedError();

    expect(error.code).toBe('SELF_AUTHORISATION_DENIED');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(error.userTitle).toBe(
      'Un sobrecupo lo autoriza otra persona, no quien lo agenda. Indique al profesional que lo autoriza',
    );
  });

  it('AG-101 answers OVERBOOKING_NOT_AUTHORISED naming the required permission', () => {
    const error = new OverbookingNotAuthorisedError('agenda:overbook');

    expect(error.code).toBe('OVERBOOKING_NOT_AUTHORISED');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    // El código es configuración de la sede — un administrador lo lee en la
    // pantalla de parámetros—; lo que esa persona SÍ tiene no sale de aquí.
    expect(error.params).toEqual({ requiredPermission: 'agenda:overbook' });
    expect(error.fieldErrors?.[0]?.field).toBe('overbookingAuthorisedById');
  });

  it('AG-100 answers OVERBOOKING_LIMIT_REACHED stating the cap in force', () => {
    const error = new OverbookingLimitReachedError(2);

    expect(error.code).toBe('OVERBOOKING_LIMIT_REACHED');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.params).toEqual({ cap: 2 });
    expect(error.userTitle).toBe(
      'Este profesional ya tiene los 2 sobrecupos que admite la sede ese día',
    );
    // Singular, porque «los 1 sobrecupos» es una frase que delata un sistema.
    expect(new OverbookingLimitReachedError(1).userTitle).toBe(
      'Este profesional ya tiene el sobrecupo que admite la sede ese día',
    );
  });

  it('AG-038 answers BLOCK_OVERLAPS_APPOINTMENTS enumerating the appointments', () => {
    const error = new BlockOverlapsAppointmentsError([
      { id: 'entry-a', startsAt: new Date('2026-09-14T13:00:00Z') },
      { id: 'entry-b', startsAt: new Date('2026-09-14T13:40:00Z') },
    ]);

    expect(error.code).toBe('BLOCK_OVERLAPS_APPOINTMENTS');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.params).toEqual({
      blockingCount: 2,
      blockingEntryIds: 'entry-a,entry-b',
    });
    // Las horas en hora de pared ecuatoriana (AG-001), que es lo que se lee.
    expect(error.fieldErrors?.[0]?.message).toBe(
      'Hay 2 citas dentro de ese intervalo: 08:00, 08:40',
    );
  });

  it('AG-038 names at most five hours and says how many more there are', () => {
    // Un bloqueo de una semana de vacaciones cruza cuarenta citas, y una frase
    // con cuarenta horas dentro no la lee nadie. Los identificadores de todas
    // siguen en `params` para el cliente que quiera listarlas.
    const many = Array.from({ length: 7 }, (_, index) => ({
      id: `entry-${index}`,
      startsAt: new Date(Date.UTC(2026, 8, 14, 13 + index, 0)),
    }));

    const error = new BlockOverlapsAppointmentsError(many);

    expect(error.fieldErrors?.[0]?.message).toContain('y 2 más');
    expect(error.params.blockingCount).toBe(7);
  });

  it('AG-038 says «una cita» in the singular', () => {
    const error = new BlockOverlapsAppointmentsError([
      { id: 'entry-a', startsAt: new Date('2026-09-14T13:00:00Z') },
    ]);

    expect(error.fieldErrors?.[0]?.message).toBe(
      'Hay una cita a las 08:00 dentro de ese intervalo',
    );
  });

  it('AG-035, AG-038 register the six E4 codes in the frozen public catalogue', () => {
    for (const code of [
      'OVERBOOKING_NOT_ALLOWED',
      'OVERBOOKING_REASON_REQUIRED',
      'OVERBOOKING_LIMIT_REACHED',
      'OVERBOOKING_NOT_AUTHORISED',
      'SELF_AUTHORISATION_DENIED',
      'BLOCK_OVERLAPS_APPOINTMENTS',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });

  /* ─── Lista de espera (E5: AG-060 a AG-067) ─────────────────────────────── */

  it('AG-071 answers WAITLIST_ENTRY_NOT_FOUND without saying whether it exists elsewhere', () => {
    const error = new WaitlistEntryNotFoundError();

    expect(error.code).toBe('WAITLIST_ENTRY_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
    expect(error.userTitle).toBe(
      'Esa inscripción en lista de espera no existe en esta sede. Actualice la lista',
    );
    // Ni sede ni ficha en el texto: distinguir «existe en otra sede» de «no
    // existe» confirmaría quién espera en sedes ajenas.
    expect(error.userTitle).not.toMatch(/otra sede|paciente/i);
  });

  it('AG-067 answers WAITLIST_ENTRY_CLOSED as a conflict, and tells how to go on', () => {
    const error = new WaitlistEntryClosedError();

    expect(error.code).toBe('WAITLIST_ENTRY_CLOSED');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'Esa inscripción ya está cerrada y no vuelve a la lista. Si el paciente sigue esperando, inscríbalo de nuevo',
    );
  });

  it('AG-064 answers WAITLIST_ACCEPTANCE_REQUIRED naming what has to be recorded first', () => {
    const error = new WaitlistAcceptanceRequiredError();

    expect(error.code).toBe('WAITLIST_ACCEPTANCE_REQUIRED');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'Registre primero el intento de contacto en que el paciente aceptó el cupo',
    );
  });

  it('AG-063 answers WAITLIST_PATIENT_MISMATCH without naming the other chart', () => {
    const error = new WaitlistPatientMismatchError();

    expect(error.code).toBe('WAITLIST_PATIENT_MISMATCH');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'La cita indicada no es de la persona que espera. Elija la cita creada para ese paciente',
    );
    // AG-074, SC-006: quien está en el mostrador puede no tener acceso a esa
    // otra cita, y el mensaje no se la enseña.
    expect(error.message).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('AG-063 answers WAITLIST_SLOT_ALREADY_CLAIMED as a conflict when another entry took the slot', () => {
    const error = new WaitlistSlotAlreadyClaimedError();

    expect(error.code).toBe('WAITLIST_SLOT_ALREADY_CLAIMED');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'Ese cupo ya se asignó a otra persona de la lista. Actualice la lista y proponga otro',
    );
  });

  it('AG-061 answers SLOT_NOT_RELEASED when the named entry still occupies the calendar', () => {
    const error = new SlotNotReleasedError();

    expect(error.code).toBe('SLOT_NOT_RELEASED');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'Ese horario sigue ocupado: la lista de espera se propone sobre un cupo ya liberado',
    );
  });

  it('AG-061 answers RELEASED_SLOT_IN_THE_PAST when the freed hour has already gone', () => {
    const error = new ReleasedSlotInThePastError();

    expect(error.code).toBe('RELEASED_SLOT_IN_THE_PAST');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.userTitle).toBe(
      'Ese cupo ya pasó y no hay nada que ofrecer. Proponga la lista sobre un cupo liberado que aún no haya empezado',
    );
  });

  it('AG-061 keeps RELEASED_SLOT_IN_THE_PAST apart from BOOKING_IN_THE_PAST', () => {
    const proposing = new ReleasedSlotInThePastError();
    const booking = new BookingInThePastError();

    // Son el mismo HECHO —una hora que pasó— y dos situaciones distintas: al
    // proponer no se reserva nada, así que no hay campo que corregir. Un
    // `errors[]` señalando `startsAt` mandaría a recepción a arreglar una
    // casilla que esta pantalla no tiene.
    expect(proposing.code).not.toBe(booking.code);
    expect(proposing.fieldErrors).toBeUndefined();
    expect(booking.fieldErrors?.[0]?.field).toBe('startsAt');
  });

  it('AG-060, AG-067 register the seven E5 codes in the frozen public catalogue', () => {
    for (const code of [
      'WAITLIST_ENTRY_NOT_FOUND',
      'WAITLIST_ENTRY_CLOSED',
      'WAITLIST_ACCEPTANCE_REQUIRED',
      'WAITLIST_PATIENT_MISMATCH',
      'WAITLIST_SLOT_ALREADY_CLAIMED',
      'SLOT_NOT_RELEASED',
      'RELEASED_SLOT_IN_THE_PAST',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});
