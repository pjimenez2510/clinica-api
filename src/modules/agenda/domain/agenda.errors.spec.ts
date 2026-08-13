import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import {
  AgendaEntryHasEncounterError,
  AgendaEntryNotFoundError,
  BookingRetryExhaustedError,
  InvalidAgendaTransitionError,
  InvalidBookingChannelError,
  InvalidSlotDurationError,
  NoShowBeforeStartError,
  OutsideScheduleRuleError,
  SlotNotAlignedError,
} from './agenda.errors';

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
