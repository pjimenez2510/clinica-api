import {
  BusinessRuleViolation,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import {
  type ClinicalDate,
  clinicalDateOf,
  wallClockOf,
} from '../../../shared/domain/clinic-time';
import type { AgendaEntryStatus } from './agenda-entry';

/**
 * What can go wrong when booking against the schedule, in business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (ValidationError and BusinessRuleViolation are both 422), which is what lets
 * these rules run from a worker or a CLI import.
 *
 * NOT declared here: `PRACTITIONER_SLOT_TAKEN` and `ROOM_SLOT_TAKEN`. Those
 * two are the two `EXCLUDE USING gist` constraints speaking, and they are
 * produced by the PostgreSQL error mapping, which has its own table. Restating
 * them in TypeScript would be a second, weaker copy of a rule the database
 * already guarantees.
 */

/** AG-028. */
export class OutsideScheduleRuleError extends BusinessRuleViolation {
  readonly code = 'OUTSIDE_SCHEDULE_RULE';
  override readonly userTitle =
    'El horario solicitado no está dentro de la agenda del profesional. Elija un cupo disponible';

  constructor() {
    // No practitioner, site or patient identifier in the message: it reaches
    // the logs, and who is being booked with whom is not log material.
    super('Requested interval is not covered by any schedule rule in force');
  }
}

/** AG-034. */
export class InvalidBookingChannelError extends ValidationError {
  readonly code = 'INVALID_BOOKING_CHANNEL';
  override readonly userTitle =
    'Indique cómo se solicitó la cita: teléfono, ventanilla, web o referencia';

  constructor() {
    super(
      'Booking channel must be one of PHONE, WALK_IN, WEB or REFERRAL',
      {},
      [
        {
          field: 'bookingChannel',
          code: 'INVALID_BOOKING_CHANNEL',
          // The admitted values are the stable codes, not their translations:
          // this is what the client sends back.
          message: 'Valores admitidos: PHONE, WALK_IN, WEB, REFERRAL',
        },
      ],
    );
  }
}

/**
 * AG-012.
 *
 * WHY `INVALID_SLOT_DURATION` AND NOT SOMETHING ELSE. The spec names the code
 * for every other requirement of this delivery and leaves this one open. The
 * two candidates were `DURATION_NOT_SLOT_MULTIPLE`, which describes the
 * arithmetic, and this one, which describes what the caller got wrong. It
 * reads the same way as its neighbour `INVALID_BOOKING_CHANNEL` — both are
 * "the value you sent is not one this schedule admits" — and it survives the
 * rule changing shape: if a rule ever admits a list of durations instead of a
 * multiple, the code still describes the rejection, and a public code that has
 * to be renamed breaks every client that branches on it.
 *
 * `params` carries the admitted length so the client can say what to change,
 * which is the second half of the requirement ("indicando la duración
 * admitida"). Numbers only: nothing here identifies a patient.
 */
export class InvalidSlotDurationError extends BusinessRuleViolation {
  readonly code = 'INVALID_SLOT_DURATION';
  override readonly userTitle =
    'La duración de la cita no coincide con los cupos del profesional. Ajuste la hora de fin';

  constructor(requestedMinutes: number, slotMinutes: number) {
    super(
      `Requested ${requestedMinutes} minutes, not a multiple of the ${slotMinutes} minute slot`,
      { requestedMinutes, slotMinutes },
      [
        {
          field: 'endsAt',
          code: 'INVALID_SLOT_DURATION',
          message: `La duración debe ser un múltiplo de ${slotMinutes} minutos`,
        },
      ],
    );
  }
}

/**
 * The consulting room asked for belongs to a different site.
 *
 * WHY IT IS A RULE OF THIS MODULE AND NOT A DATABASE ERROR (yet). Nothing ties
 * `agenda_entry.room_id` to `agenda_entry.site_id`: the only guarantee is the
 * foreign key to `site_room(id)`, which happily accepts a room of any site. The
 * damage is twofold — the request occupies a physical resource of a site the
 * caller has no scope over (AG-071, which the site in the path exists to
 * enforce), and the entry never appears in that site's agenda, which filters by
 * `site_id`, so the room looks free while
 * `agenda_entry_no_room_overlap` refuses the legitimate booking with no
 * explanation. The lasting guarantee is a composite foreign key against
 * `site_room(id, site_id)`, which is a migration.
 *
 * NEITHER IDENTIFIER IS NAMED. Answering "that room is at site X" would tell a
 * caller with no scope over X something about X's rooms, one guess at a time.
 */
export class RoomNotInSiteError extends BusinessRuleViolation {
  readonly code = 'ROOM_NOT_IN_SITE';
  override readonly userTitle =
    'El consultorio no pertenece a esta sede. Elija uno de la sede en la que está agendando';

  constructor() {
    super('Requested room belongs to a different site', {}, [
      {
        field: 'roomId',
        code: 'ROOM_NOT_IN_SITE',
        message: 'Seleccione un consultorio de esta sede',
      },
    ]);
  }
}

/** The slot starts either side of the requested one; `null` where the grid ends. */
export interface NeighbouringSlotStarts {
  previous: Date | null;
  next: Date | null;
}

/**
 * AG-104 (D-007).
 *
 * WHY ONLY THE TWO NEIGHBOURS AND NOT THE WHOLE DAY. "Los inicios admitidos más
 * próximos" could be read as the day's full grid, and that reading is worse
 * here: the grid a client may actually book is the one AG-003 derives WITH
 * occupancy subtracted, and this rule runs before anything is known about who
 * else holds a slot. Listing the day from here would hand back starts that are
 * already taken and invite a second rejection. The start before and the start
 * after are enough to correct the input, they are always both bookable
 * candidates as far as this rule can tell, and they say nothing the caller did
 * not already ask about.
 *
 * `params` carries instants in ISO-8601 — what the client sends back — and the
 * sentence carries the Ecuadorian wall clock, which is what a receptionist
 * reads. Instants only: nothing here names a patient or a practitioner.
 */
export class SlotNotAlignedError extends BusinessRuleViolation {
  readonly code = 'SLOT_NOT_ALIGNED';
  override readonly userTitle =
    'La cita debe empezar al inicio de un cupo del profesional. Ajuste la hora de inicio';

  constructor(
    requestedStart: Date,
    admitted: NeighbouringSlotStarts,
    timeZone?: string,
  ) {
    const candidates = [admitted.previous, admitted.next].filter(
      (start): start is Date => start !== null,
    );
    const clocks = candidates.map((start) =>
      wallClockOf(start, timeZone).toString(),
    );

    super(
      `Requested start ${requestedStart.toISOString()} is not a slot boundary of the applicable rule`,
      {
        requestedStart: requestedStart.toISOString(),
        ...(admitted.previous === null
          ? {}
          : { previousStart: admitted.previous.toISOString() }),
        ...(admitted.next === null
          ? {}
          : { nextStart: admitted.next.toISOString() }),
      },
      [
        {
          field: 'startsAt',
          code: 'SLOT_NOT_ALIGNED',
          message: describeAdmittedStarts(clocks),
        },
      ],
    );
  }
}

/**
 * AG-031. The appointment starts before now, at a site that does not admit it.
 *
 * WHY THE REFUSAL IS THE DEFAULT and the permission is the exception
 * (`site_parameter.allow_past_booking`, false out of the box). With a minimum
 * lead of zero — D-001 — a site already accepts the appointment of the patient
 * standing at the counter right now, so nothing legitimate needs the past
 * except recording an attention that already happened. That case is real, and
 * it is also indistinguishable from filling holes backwards as if they had
 * been booked on time. A site opening it is that site's decision; shipping it
 * open would be ours.
 *
 * NO INSTANT TRAVELS in the message or the parameters, unlike its two
 * neighbours: there is nothing to state that the caller does not already know
 * — they sent the start, and «now» is on their own screen.
 */
export class BookingInThePastError extends BusinessRuleViolation {
  readonly code = 'BOOKING_IN_THE_PAST';
  override readonly userTitle =
    'La cita no puede empezar en una hora que ya pasó. Elija una hora futura';

  constructor() {
    super(
      'Requested start precedes the current instant and the site does not admit past bookings',
      {},
      [
        {
          field: 'startsAt',
          code: 'BOOKING_IN_THE_PAST',
          message: 'La hora indicada ya pasó',
        },
      ],
    );
  }
}

/**
 * AG-032. Closer than the minimum lead the site requires.
 *
 * IT CARRIES THE FIRST ADMISSIBLE INSTANT because the requirement demands it
 * («indicando el primer instante admisible»), and because the alternative is a
 * receptionist trying 10:00, 10:15 and 10:30 until one is accepted. `params`
 * holds the ISO-8601 instant, which is what the client sends back; the
 * sentence holds the Ecuadorian wall clock and date, which is what a person
 * reads (AG-001).
 *
 * THE MINIMUM LEAD ITSELF TRAVELS TOO. It is a number of minutes of the site's
 * own configuration, not health data, and without it the client cannot explain
 * why an hour that is plainly in the future was refused.
 */
export class BookingTooSoonError extends BusinessRuleViolation {
  readonly code = 'BOOKING_TOO_SOON';
  override readonly userTitle =
    'La cita se pide con menos antelación de la que admite esta sede. Elija una hora más tarde';

  constructor(earliestStart: Date, minLeadMinutes: number, timeZone?: string) {
    super(
      `Requested start is closer than the ${minLeadMinutes} minute minimum lead of the site`,
      {
        earliestStart: earliestStart.toISOString(),
        minLeadMinutes,
      },
      [
        {
          field: 'startsAt',
          code: 'BOOKING_TOO_SOON',
          message:
            `La primera cita que puede reservarse es el ${spanishDate(clinicalDateOf(earliestStart, timeZone))} ` +
            `a las ${wallClockOf(earliestStart, timeZone).toString()}`,
        },
      ],
    );
  }
}

/**
 * AG-033. Further ahead than the maximum lead the site publishes.
 *
 * THE LIMIT IS A DATE AND NOT AN INSTANT, and the requirement says so: it asks
 * the refusal to name «la última fecha admisible», while AG-032 asks for «el
 * primer instante admisible». The units agree with that reading — minutes for
 * the minimum lead, days for the maximum — and a date boundary is the one a
 * receptionist can act on: every hour of that day is bookable, so the sentence
 * is true as written instead of true until 14:37.
 */
export class BookingTooFarError extends BusinessRuleViolation {
  readonly code = 'BOOKING_TOO_FAR';
  override readonly userTitle =
    'La cita se pide con demasiada antelación para esta sede. Elija una fecha más cercana';

  constructor(latestDate: ClinicalDate, maxLeadDays: number) {
    super(
      `Requested start is beyond the ${maxLeadDays} day maximum lead of the site`,
      { latestDate, maxLeadDays },
      [
        {
          field: 'startsAt',
          code: 'BOOKING_TOO_FAR',
          message: `La última fecha que puede reservarse es el ${spanishDate(latestDate)}`,
        },
      ],
    );
  }
}

/**
 * AG-026. PostgreSQL kept aborting the booking for serialisation and the
 * retries ran out.
 *
 * WHY IT IS NOT A CONFLICT, which is the whole point of the requirement. A
 * `40001` says nothing about the slot: the transaction was aborted before it
 * could decide. Answering 409 `PRACTITIONER_SLOT_TAKEN` would tell a
 * receptionist to pick another time for a slot that may well be free, and she
 * would move a patient's appointment for nothing. 503 with `Retry-After` says
 * the true thing — ask again — and it is the answer a client can automate.
 *
 * WHY `ExternalServiceError`, whose examples are the SRI and the IESS. The
 * status is decided by CATEGORY in `problem-details.filter.ts`, and this is
 * the category that means "a system we depend on failed transiently, retrying
 * is the right response": `isRetryable` maps to 503, and to 502 when it is
 * not. PostgreSQL is not a third party, but the shape of the failure and of
 * the correct answer are exactly this one. The alternative was a new category
 * used by a single error.
 *
 * THE CODE IS A DECISION THIS DELIVERY MADE: AG-026 names a status and a
 * header but no code. `BOOKING_RETRY_EXHAUSTED` states what happened —
 * we already retried, and it kept failing — which is what a client needs in
 * order to decide between backing off and telling the user.
 */
export class BookingRetryExhaustedError extends ExternalServiceError {
  readonly code = 'BOOKING_RETRY_EXHAUSTED';
  readonly service = 'postgresql';
  readonly isRetryable = true;
  override readonly userTitle =
    'La agenda está muy solicitada en este momento. Intente reservar de nuevo en unos segundos';

  override readonly retryAfterSeconds: number;

  constructor(attempts: number, retryAfterSeconds = 2) {
    // Attempt count only: nothing here names a patient, a practitioner or an
    // hour, and this message does reach the logs.
    super(`Booking abandoned after ${attempts} serialisation failures`, {
      attempts,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The Spanish label of each status, as the SCREEN names them.
 *
 * Lives next to the one error that speaks them because the requirement is
 * about the MESSAGE: AG-040 demands that the refusal name the current state,
 * and «CHECKED_IN» names it to a programmer, not to a receptionist.
 */
const STATUS_LABEL: Readonly<Record<AgendaEntryStatus, string>> = {
  BOOKED: 'Agendada',
  CONFIRMED: 'Confirmada',
  CHECKED_IN: 'En sala',
  IN_PROGRESS: 'En atención',
  FULFILLED: 'Atendida',
  CANCELLED: 'Anulada',
  NO_SHOW: 'No asistió',
  BLOCKED: 'Bloqueada',
};

/**
 * AG-040. The requested pair is not in the table of SPEC §5.
 *
 * A CONFLICT (409) and not a validation error, and the spec says so
 * explicitly: the request was well-formed, it is the CURRENT STATE of the
 * appointment that refuses it — usually because a colleague moved it first.
 * The title names that state, which is the one thing the caller's screen no
 * longer knows; `params` carries both ends in stable codes for the client
 * that branches.
 */
export class InvalidAgendaTransitionError extends ConflictError {
  readonly code = 'INVALID_AGENDA_TRANSITION';
  override readonly userTitle: string;

  constructor(from: AgendaEntryStatus, to: AgendaEntryStatus) {
    // Status codes only: no patient, practitioner or hour reaches a log.
    super(`Transition ${from} to ${to} is not admitted`, { from, to });
    this.userTitle = `La cita está en estado «${STATUS_LABEL[from]}» y no admite ese cambio. Actualice la agenda`;
  }
}

/**
 * AG-045. The appointment already has an encounter behind it.
 *
 * Cancelling or marking a no-show would deny an attention that is already
 * documented in the clinical record — the record wins, the agenda adjusts.
 */
export class AgendaEntryHasEncounterError extends ConflictError {
  readonly code = 'AGENDA_ENTRY_HAS_ENCOUNTER';
  override readonly userTitle =
    'La cita ya tiene una atención registrada: no puede anularse ni marcarse como inasistencia';

  constructor() {
    super('Agenda entry already has an encounter');
  }
}

/**
 * AG-043. A no-show declared before the appointment even starts.
 *
 * THE CODE IS A DECISION THIS DELIVERY MADE, like `BOOKING_RETRY_EXHAUSTED`
 * before it: the spec demands the refusal and names no code, and without one
 * a client cannot tell "too early to mark" from any other 422.
 */
export class NoShowBeforeStartError extends BusinessRuleViolation {
  readonly code = 'NO_SHOW_BEFORE_START';
  override readonly userTitle =
    'La inasistencia solo puede marcarse desde la hora de inicio de la cita';

  constructor() {
    // No instants in the message: the start of an appointment says when
    // somebody is expected somewhere, and this text reaches the logs.
    super('NO_SHOW requested before the appointment start');
  }
}

/**
 * AG-044. A cancellation with no reason, refused where it cannot be walked
 * around.
 *
 * The DTO already refuses this per-field over HTTP; this error exists for the
 * INTERNAL callers — E3's reschedule cancels the original entry from inside
 * the service, and a DEBERÁ that only the transport enforces is not a
 * guarantee (adversarial review of E2, P2-3).
 */
export class CancellationReasonRequiredError extends ValidationError {
  readonly code = 'CANCELLATION_REASON_REQUIRED';
  override readonly userTitle =
    'Indique el motivo de la anulación. Queda registrado en el historial de la cita';
  override readonly fieldErrors = [
    {
      field: 'reason',
      code: 'CANCELLATION_REASON_REQUIRED',
      message: 'Indique el motivo de la anulación',
    },
  ];

  constructor() {
    super('CANCELLED requested without a reason');
  }
}

/**
 * The entry does not exist — or belongs to a site other than the route's.
 *
 * ONE MESSAGE FOR BOTH, deliberately: answering "it exists, elsewhere" would
 * confirm entries of sites the caller has no scope over, one guessed
 * identifier at a time (AG-071, same reasoning as `ROOM_NOT_IN_SITE`).
 */
export class AgendaEntryNotFoundError extends NotFoundError {
  readonly code = 'AGENDA_ENTRY_NOT_FOUND';
  override readonly userTitle =
    'La cita no existe en esta sede. Actualice la agenda';

  constructor() {
    super('Agenda entry not found at this site');
  }
}

/* ─── Lista de espera (E5: AG-060 a AG-067) ─────────────────────────────── */

/**
 * AG-071. The waiting list entry does not exist, or belongs to another site.
 *
 * ONE MESSAGE FOR BOTH, for the same reason as `AgendaEntryNotFoundError`:
 * answering «existe, en otra sede» would confirm who is waiting elsewhere, one
 * guessed identifier at a time.
 */
export class WaitlistEntryNotFoundError extends NotFoundError {
  readonly code = 'WAITLIST_ENTRY_NOT_FOUND';
  override readonly userTitle =
    'Esa inscripción en lista de espera no existe en esta sede. Actualice la lista';

  constructor() {
    super('Waitlist entry not found at this site');
  }
}

/**
 * AG-067. The entry is already `SCHEDULED`, `EXPIRED` or `CANCELLED`.
 *
 * 409 AND NOT 422: nothing sent is wrong — the entry moved on, and what to do
 * about it is enrol the patient again, which is exactly what the message says.
 * The entry NEVER reopens: it would return to the queue with its original
 * seniority, ahead of everybody who enrolled afterwards, and
 * `trg_waitlist_entry_closure_final` guarantees it in the database too.
 */
export class WaitlistEntryClosedError extends ConflictError {
  readonly code = 'WAITLIST_ENTRY_CLOSED';
  override readonly userTitle =
    'Esa inscripción ya está cerrada y no vuelve a la lista. Si el paciente sigue esperando, inscríbalo de nuevo';

  constructor() {
    super('Waitlist entry is closed and cannot be acted upon');
  }
}

/**
 * AG-064, second half: «NO DEBERÁ reasignar automáticamente el cupo sin
 * confirmación».
 *
 * IT IS THE DATABASE THAT REFUSES IT, not this class:
 * `trg_waitlist_entry_conversion_consented` looks for an attempt with outcome
 * `ACCEPTED` and aborts without one, so an import or a `psql` cannot get past
 * it either. What this adds is the sentence a receptionist can act on, in
 * place of a bare `CHECK_FAILED` naming a trigger.
 *
 * WHAT IT DOES NOT FORBID is the acceptance given at the counter: that is
 * recorded like any other, as an attempt with outcome `ACCEPTED` and the
 * person who took it as author. What it forbids is the acceptance nobody
 * wrote down.
 */
export class WaitlistAcceptanceRequiredError extends BusinessRuleViolation {
  readonly code = 'WAITLIST_ACCEPTANCE_REQUIRED';
  override readonly userTitle =
    'Registre primero el intento de contacto en que el paciente aceptó el cupo';

  constructor() {
    super('Waitlist entry has no recorded acceptance');
  }
}

/**
 * AG-063. The appointment being linked belongs to another chart.
 *
 * NO IDENTIFIER AND NO NAME IN THE MESSAGE (AG-074, SC-006): whoever is at the
 * desk may have no access to the other appointment, and «la cita es de Juan
 * Pérez» would tell them anyway.
 *
 * A block of agenda lands here too and needs no separate code: a block has no
 * patient at all (`agenda_entry_patient_coherence`), so «is it the same
 * chart?» answers no.
 */
export class WaitlistPatientMismatchError extends BusinessRuleViolation {
  readonly code = 'WAITLIST_PATIENT_MISMATCH';
  override readonly userTitle =
    'La cita indicada no es de la persona que espera. Elija la cita creada para ese paciente';

  constructor() {
    super('Linked appointment belongs to a different patient');
  }
}

/**
 * AG-063. Another entry already claimed that appointment.
 *
 * THE RACE THIS FEATURE EXISTS TO ARBITRATE: two receptionists working the
 * same freed slot hand it to two people, and without
 * `waitlist_entry_one_per_converted_entry` the list would say both were served
 * with one slot — and the one who was left out would appear as attended.
 *
 * 409 and not 422: what was sent was right when it was sent, and the answer is
 * to look for another slot, which is what the message says.
 */
export class WaitlistSlotAlreadyClaimedError extends ConflictError {
  readonly code = 'WAITLIST_SLOT_ALREADY_CLAIMED';
  override readonly userTitle =
    'Ese cupo ya se asignó a otra persona de la lista. Actualice la lista y proponga otro';

  constructor() {
    super('Appointment is already linked to another waitlist entry');
  }
}

/**
 * AG-061. The entry named as the freed slot still occupies the calendar.
 *
 * THE REQUIREMENT'S PRECONDITION, ENFORCED RATHER THAN ASSUMED: «CUANDO se
 * libere un cupo QUE OCUPABA CALENDARIO». Proposing candidates for an
 * appointment that is still standing would have reception phoning people about
 * an hour that is not free, and the patient who holds it turning up to find it
 * given away.
 *
 * 422 and not 409: what is wrong is which entry was named, and the caller can
 * fix it by naming the one that was actually released.
 */
export class SlotNotReleasedError extends BusinessRuleViolation {
  readonly code = 'SLOT_NOT_RELEASED';
  override readonly userTitle =
    'Ese horario sigue ocupado: la lista de espera se propone sobre un cupo ya liberado';

  constructor() {
    super('The named entry still occupies the calendar');
  }
}

/**
 * AG-061. The slot was freed, but its hour has already gone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CODE OF ITS OWN AND NOT `BOOKING_IN_THE_PAST`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fact looks the same — an hour that passed cannot be occupied — and the
 * situation is not:
 *
 *   * NOTHING IS BEING BOOKED HERE. This is a `GET` naming a released entry;
 *     there is no `startsAt` in the request, so the field error that
 *     `BOOKING_IN_THE_PAST` carries would send a receptionist to correct a box
 *     that does not exist on this screen, and a client branching on that code
 *     to "fix the start time" would fire on a query.
 *   * THE CONDITION IS DIFFERENT. `BOOKING_IN_THE_PAST` obeys the site's
 *     `allow_past_booking` (AG-031), so a site that records attentions after
 *     the fact never sees it. This refusal is unconditional: a proposal is a
 *     call asking somebody to come, and no parameter makes a past hour
 *     attendable.
 *   * WHAT TO DO IS DIFFERENT. There is no future hour to pick instead —
 *     there is nothing to offer on this slot at all.
 *
 * 422 AND NOT 409, like its neighbour `SLOT_NOT_RELEASED` on the same route:
 * both say «esta entrada no sirve como cupo a repartir», one because it still
 * occupies the calendar and the other because its hour is gone, and a client
 * handles the two the same way — show the sentence, show no list. A 409 would
 * suggest refreshing and trying again, which is exactly the wrong hint for an
 * hour that is never coming back.
 *
 * NO IDENTIFIER AND NO HOUR IN THE MESSAGE (AG-074): the entry that was freed
 * belongs to another patient.
 */
export class ReleasedSlotInThePastError extends BusinessRuleViolation {
  readonly code = 'RELEASED_SLOT_IN_THE_PAST';
  override readonly userTitle =
    'Ese cupo ya pasó y no hay nada que ofrecer. Proponga la lista sobre un cupo liberado que aún no haya empezado';

  constructor() {
    super('The released slot starts before the current instant');
  }
}

/* ─── Sobrecupo y bloqueos (E4: AG-035, AG-038, AG-039, AG-100 a AG-103) ─── */

/**
 * AG-039. This site does not admit overbookings.
 *
 * NOTHING IN THE FORM IS WRONG, so it carries no field error: what refuses the
 * booking is a parameter of the site, and the only way forward is somebody
 * with `settings:manage` changing it. Saying which box to correct would send a
 * receptionist round a form where every box is right.
 */
export class OverbookingNotAllowedError extends BusinessRuleViolation {
  readonly code = 'OVERBOOKING_NOT_ALLOWED';
  override readonly userTitle =
    'Esta sede no admite sobrecupos. Busque un cupo libre o pida que se habilite el sobrecupo para la sede';

  constructor() {
    super('The site does not admit overbookings');
  }
}

/**
 * AG-035. An overbooking with no reason.
 *
 * IT LIVES IN THE SERVICE AND NOT ONLY IN THE DTO, for the same reason
 * `CancellationReasonRequiredError` does (adversarial review of E2, P2-3): a
 * DEBERÁ that only the transport enforces stops being true the first time an
 * internal caller books one. The base says it a third time
 * (`agenda_entry_overbooking_coherence`), because an overbooking with no
 * constancia is exactly the record D-005 exists to avoid.
 */
export class OverbookingReasonRequiredError extends ValidationError {
  readonly code = 'OVERBOOKING_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué se agenda este sobrecupo. Queda registrado en la cita';
  override readonly fieldErrors = [
    {
      field: 'overbookingReason',
      code: 'OVERBOOKING_REASON_REQUIRED',
      message: 'Indique el motivo del sobrecupo',
    },
  ];

  constructor() {
    super('Overbooking requested without a reason');
  }
}

/**
 * AG-103, D-005. Whoever books an overbooking named themselves as the
 * authoriser.
 *
 * THE SEPARATION OF PEOPLE IS THE CONTROL. An authorisation field that fills
 * itself in authorises nothing, so this is not a formality: it is the only
 * thing that makes `overbooking_authorised_by_id` mean anything. The exception
 * — `agenda:overbook:self`, for the doctor on call at 21:00 with nobody else
 * signed in — is granted deliberately and to a person, never inherited.
 *
 * 403 AND NOT 422: what was sent is well-formed and the hour may be free. What
 * is missing is somebody else's authorisation, and the sentence says so — the
 * way out is to ask for it, not to correct a field.
 *
 * NEITHER USER IS NAMED. The caller knows who they are, and naming the person
 * who WOULD be able to authorise would turn the endpoint into a directory of
 * who holds which permission.
 */
export class SelfAuthorisationDeniedError extends ForbiddenError {
  readonly code = 'SELF_AUTHORISATION_DENIED';
  override readonly userTitle =
    'Un sobrecupo lo autoriza otra persona, no quien lo agenda. Indique al profesional que lo autoriza';

  constructor() {
    super('The requester named themselves as the overbooking authoriser');
  }
}

/**
 * AG-101. The person named as authoriser does not hold the permission this
 * site requires for it.
 *
 * SAME ANSWER FOR «THAT ACCOUNT DOES NOT EXIST», and it is deliberate: an
 * identifier that matches nobody holds no permission, and answering 404 would
 * turn the booking form into a way of confirming which accounts exist, one
 * guess at a time (the reasoning of `ROOM_NOT_IN_SITE` and of
 * `AGENDA_ENTRY_NOT_FOUND`).
 *
 * THE REQUIRED PERMISSION TRAVELS in `params` and NOT the authoriser's own
 * permissions: the code is configuration of the site — the same string an
 * administrator can read on the parameters screen — while listing what that
 * person does hold would be handing out somebody else's access profile.
 */
export class OverbookingNotAuthorisedError extends ForbiddenError {
  readonly code = 'OVERBOOKING_NOT_AUTHORISED';
  override readonly userTitle =
    'Quien indicó no puede autorizar sobrecupos en esta sede. Indique a un profesional que sí pueda';

  constructor(requiredPermission: string) {
    super(
      'The named authoriser lacks the permission the site requires for overbooking',
      { requiredPermission },
      [
        {
          field: 'overbookingAuthorisedById',
          code: 'OVERBOOKING_NOT_AUTHORISED',
          message: 'Esa persona no puede autorizar sobrecupos en esta sede',
        },
      ],
    );
  }
}

/**
 * AG-100. The practitioner already used up the site's overbookings for that
 * CLINICAL DATE.
 *
 * A CONFLICT (409) AND NOT A VALIDATION ERROR: everything sent is correct, and
 * the same body would be accepted tomorrow. What refuses it is the state of
 * that day's agenda.
 *
 * THE CAP TRAVELS because the requirement asks for it («indicando el tope
 * vigente») and because «no caben más» without a number reads as a bug to
 * whoever is at the counter. The count of what is already booked does not: it
 * is always the cap by the time this is thrown.
 */
export class OverbookingLimitReachedError extends ConflictError {
  readonly code = 'OVERBOOKING_LIMIT_REACHED';
  override readonly userTitle: string;

  constructor(cap: number) {
    // Numbers only: no patient, no practitioner, no hour reaches a log.
    super(`Practitioner already holds ${cap} overbookings for that clinical date`, { cap }); // prettier-ignore
    this.userTitle =
      cap === 1
        ? 'Este profesional ya tiene el sobrecupo que admite la sede ese día'
        : `Este profesional ya tiene los ${cap} sobrecupos que admite la sede ese día`;
  }
}

/**
 * AG-038. A block over an interval that already holds appointments.
 *
 * IT ENUMERATES THEM, and that is half the requirement: «no se puede» without
 * the list leaves whoever is blocking a morning to find those appointments by
 * hand, one day view at a time.
 *
 * WHAT MAY BE SAID OF THEM (AG-072, AG-074, AG-109, SC-006): the identifier
 * and the hours. Not the name, not the chart, not the reason for the visit.
 * AG-109 grants the patient's name to the day's LISTING — a route with its own
 * permission and site scope — and never to a problem document, which reaches
 * logs and support screenshots.
 *
 * WHAT THE CLIENT ACTUALLY READS IS THE SENTENCE, and the enumeration is in
 * it: the problem document of this system serves `code`, `title`, `detail` and
 * `errors`, never a domain error's `params`. So the hours are what reaches the
 * counter — and they are enough to act on, because that is how an appointment
 * is found in the day's view. The identifiers stay in `params` for the server's
 * own record of what it refused; putting them in the sentence would be noise
 * nobody can use.
 *
 * A CONFLICT (409): the request is well-formed and the same interval would be
 * blockable once those appointments move.
 */
export class BlockOverlapsAppointmentsError extends ConflictError {
  readonly code = 'BLOCK_OVERLAPS_APPOINTMENTS';
  override readonly userTitle =
    'Ese intervalo ya tiene citas agendadas. Reprográmelas o anúlelas antes de bloquearlo';

  constructor(
    blocking: readonly { id: string; startsAt: Date }[],
    timeZone?: string,
  ) {
    super(
      `Block requested over ${blocking.length} appointments that occupy the calendar`,
      {
        blockingCount: blocking.length,
        blockingEntryIds: blocking.map((entry) => entry.id).join(','),
      },
      [
        {
          field: 'startsAt',
          code: 'BLOCK_OVERLAPS_APPOINTMENTS',
          message: describeBlockingAppointments(
            blocking.map((entry) => wallClockOf(entry.startsAt, timeZone).toString()), // prettier-ignore
          ),
        },
      ],
    );
  }
}

/**
 * «Hay 2 citas …», with the hours, in Ecuadorian wall clock (AG-001).
 *
 * AT MOST FIVE HOURS ARE NAMED. A block of a week's leave can cross forty
 * appointments, and a sentence with forty times in it is one nobody reads —
 * the count is what says how big the problem is, and the identifiers of every
 * one of them are still in `params` for a client that wants to list them.
 */
function describeBlockingAppointments(clocks: readonly string[]): string {
  const shown = clocks.slice(0, 5);
  const rest = clocks.length - shown.length;
  const times =
    rest > 0 ? `${shown.join(', ')} y ${rest} más` : shown.join(', ');

  return clocks.length === 1
    ? `Hay una cita a las ${times} dentro de ese intervalo`
    : `Hay ${clocks.length} citas dentro de ese intervalo: ${times}`;
}

/**
 * `2027-03-13` as Ecuador writes it: `13/03/2027`.
 *
 * The ISO form stays in `params`, which is what a client parses and sends
 * back; this is only for the sentence a person reads. No `Intl.DateTimeFormat`
 * because a `ClinicalDate` is a calendar date and not an instant — handing it
 * to a formatter means turning it into one, and that is where the zone bugs
 * come from.
 */
function spanishDate(date: ClinicalDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** The Spanish sentence for zero, one or two admitted starts. */
function describeAdmittedStarts(clocks: readonly string[]): string {
  if (clocks.length === 0) {
    // Reachable only if the rule yields no slot at all, which `slotsOfRuleOn`
    // already refuses to produce; saying nothing is still better than a
    // sentence with a hole in it.
    return 'La cita debe empezar al inicio de un cupo del horario';
  }
  if (clocks.length === 1) {
    return `El inicio admitido más próximo es ${clocks[0]}`;
  }
  return `Los inicios admitidos más próximos son ${clocks.join(' y ')}`;
}
