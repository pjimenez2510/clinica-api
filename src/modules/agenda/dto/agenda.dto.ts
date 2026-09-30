import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// AG-018: las liberadas se dejan fuera salvo que se pidan EXPLÍCITAMENTE.
import { explicitFlag } from '../../../shared/http/query-flag';

import {
  type ClinicalDate,
  MAX_RANGE_DAYS,
  clinicalDaySpan,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';

/**
 * `z.iso.date` guarantees the FORMAT; `parseClinicalDate` additionally rejects
 * impossible calendar dates (2026-02-30) and brands the result, so everything
 * past this boundary carries `ClinicalDate` and the compiler refuses raw
 * strings. The try/catch keeps an invalid date a per-field 422 instead of an
 * escaped RangeError.
 */
const clinicalDateField = (message: string) =>
  z.iso.date(message).transform((value, ctx): ClinicalDate => {
    try {
      return parseClinicalDate(value);
    } catch {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
  });

/**
 * The agenda contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const KIND = z.enum(['APPOINTMENT', 'BLOCK']);

const STATUS = z.enum([
  'BOOKED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'FULFILLED',
  'CANCELLED',
  'NO_SHOW',
  'BLOCKED',
  // AG-116, AG-117. The two outcomes the machine did not have. They appear in
  // the RESPONSE union because a stored entry can be in either; whether a
  // client may ASK for them is `transitionStatusSchema`'s business.
  'LEFT_WITHOUT_BEING_SEEN',
  'ENTERED_IN_ERROR',
]);

/**
 * AG-121. Where the patient is, on the axis the appointment status does not
 * carry.
 *
 * READ-ONLY IN THIS FILE, AND THAT IS THE REQUIREMENT. No request schema
 * accepts one of these values: AG-122 forbids any route that sets
 * `IN_PREPARATION`, `READY`, `RECEIVING_CARE`, `ON_LEAVE` or `DEPARTED`,
 * because a board that can be typed is a board that drifts from the record.
 * `ARRIVED` is written by the check-in effect and is not typed here either.
 */
const SUBJECT_STATUS = z.enum([
  'ARRIVED',
  'IN_PREPARATION',
  'READY',
  'RECEIVING_CARE',
  'ON_LEAVE',
  'DEPARTED',
]);

const BOOKING_CHANNEL = z.enum(['PHONE', 'WALK_IN', 'WEB', 'REFERRAL']);

/**
 * An instant, with its offset stated.
 *
 * The offset is REQUIRED: `2026-09-14T08:00:00` with nothing after it means
 * whatever the reader's clock happens to say, and the appointment would land
 * five hours away from where recepción meant it. The client sends `…Z` or
 * `…-05:00`; the server never guesses.
 */
const instant = (label: string) =>
  z.iso.datetime({
    offset: true,
    error: `${label} debe incluir la fecha, la hora y su zona horaria`,
  });

export const dailyAgendaQuerySchema = z.object({
  /**
   * The ECUADORIAN calendar date, not a range of instants. The service turns
   * it into `[00:00, 24:00)` in `America/Guayaquil` (AG-017).
   */
  date: clinicalDateField('Indique la fecha en formato AAAA-MM-DD'),
  practitionerId: z.uuid('Seleccione un profesional de la lista').optional(),
  roomId: z.uuid('Seleccione un consultorio de la lista').optional(),
  /** AG-018. */
  includeReleased: explicitFlag,
});
/** Query of GET /agenda/sites/:siteId/entries. */
export class DailyAgendaQueryDto extends createZodDto(dailyAgendaQuerySchema) {}

/**
 * AG-020: patient, practitioner, site, start and end are all required.
 *
 * THE SITE IS NOT IN THE BODY: it is the `:siteId` of the route, so the guard
 * can check the caller's scope over it before any pipe runs (AG-071). Guards
 * see route parameters and an unvalidated body, which is why an authorisation
 * decision may only be taken on the former.
 */
export const bookAppointmentSchema = z
  .object({
    patientId: z.uuid('Seleccione el paciente de la cita'),
    practitionerId: z.uuid('Seleccione el profesional que atenderá'),
    roomId: z.uuid('Seleccione un consultorio de la lista').optional(),
    startsAt: instant('La hora de inicio'),
    endsAt: instant('La hora de fin'),
    /**
     * AG-029, AG-034. A STRING here, not an enum, and that is deliberate: the
     * four admitted values are decided by `checkBookingChannel` in the domain,
     * which answers `INVALID_BOOKING_CHANNEL` and names them. Declaring the enum
     * here would answer a generic `VALIDATION_FAILED` instead, and the
     * requirement names the code.
     */
    bookingChannel: z.string({ error: 'Indique cómo se solicitó la cita' }),
    /**
     * SP-028. `service_type.id` — the clinic's own type of attention with its
     * base duration (SP-020), NOT a concept of the MSP clinical catalogue,
     * which is what this field named until C4.
     */
    serviceTypeId: z.uuid('Seleccione un tipo de atención válido').optional(),
    /**
     * Free text a receptionist types. It may carry a reason for the visit, which
     * is health data: it is stored, and it never reaches a log (AG-074).
     */
    reason: z
      .string()
      .trim()
      .max(512, 'El motivo no puede superar 512 caracteres')
      .optional(),
    /**
     * AG-035, D-005. The caller DECLARES a deliberate overbooking.
     *
     * THREE FLAT FIELDS AND AN EXPLICIT FLAG, rather than one nested object.
     * The flag is what makes the exception something asked for instead of
     * inferred: without it, «trae autorizador» would mean «sobrecupo», and a
     * client that sent the field by mistake would break the grid silently. And
     * flat, because every refusal about them is a per-field 422 whose path the
     * form has to match — `overbookingReason`, not `overbooking.reason`.
     */
    overbooking: z.boolean().optional(),
    /**
     * AG-035. Why the grid is being broken. ADMINISTRATIVE, and that is why it
     * is a field of its own and not `reason` above: `reason` is where recepción
     * writes the motive for the visit, which is health data no listing serves
     * back (AG-072, AG-074). This one travels in every listing (AG-036).
     */
    overbookingReason: z
      .string()
      .trim()
      .max(512, 'El motivo del sobrecupo no puede superar 512 caracteres')
      .optional(),
    /**
     * AG-101, AG-103. WHO authorises it — the doctor who will see the urgency,
     * not whoever is booking. The server compares it against the session, so
     * sending one's own id is refused unless the account holds
     * `agenda:overbook:self`.
     */
    overbookingAuthorisedById: z
      .uuid('Seleccione quién autoriza el sobrecupo')
      .optional(),
  })
  .superRefine((value, ctx) => {
    // AG-035. Both halves of the constancia are demanded PER FIELD so the form
    // highlights the box that is missing. The service demands them again — a
    // DEBERÁ that only the transport enforces is not a guarantee — and the
    // base a third time (`agenda_entry_overbooking_coherence`).
    if (value.overbooking === true) {
      if (!value.overbookingReason) {
        ctx.addIssue({
          code: 'custom',
          path: ['overbookingReason'],
          message: 'Indique el motivo del sobrecupo',
        });
      }
      if (!value.overbookingAuthorisedById) {
        ctx.addIssue({
          code: 'custom',
          path: ['overbookingAuthorisedById'],
          message: 'Indique quién autoriza el sobrecupo',
        });
      }
      return;
    }

    /**
     * AND THE OTHER DIRECTION, which matters more than it looks: a body that
     * carries a reason and an authoriser WITHOUT the flag would otherwise be
     * stored as an ordinary appointment with both fields dropped on the floor
     * — the caller believing an exception was recorded, the record saying
     * nothing. Refusing is the only answer that cannot be misread.
     */
    for (const field of [
      'overbookingReason',
      'overbookingAuthorisedById',
    ] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Marque la cita como sobrecupo para poder indicarlo',
        });
      }
    }
  });
/** Body of POST /agenda/sites/:siteId/entries. */
export class BookAppointmentDto extends createZodDto(bookAppointmentSchema) {}

/**
 * AG-037, AG-038. Closing a stretch of a practitioner's agenda.
 *
 * NO PATIENT, NO CHANNEL AND NO TYPE OF ATTENTION, and none of the three is an
 * omission: a block has no patient (AG-021), nobody requests it by telephone
 * (AG-034) and nothing is being attended. The site is the `:siteId` of the
 * route, like every other route of this controller (AG-071).
 */
export const blockAgendaSchema = z
  .object({
    practitionerId: z.uuid('Seleccione el profesional cuya agenda se bloquea'),
    /** The theatre or consulting room the block takes with it, if any. */
    roomId: z.uuid('Seleccione un consultorio de la lista').optional(),
    startsAt: instant('La hora de inicio'),
    endsAt: instant('La hora de fin'),
    /**
     * Why the agenda is closed — «Quirófano», «Vacaciones».
     *
     * OPTIONAL, AND STORED WITHOUT BEING SERVED BACK. It lands in the same
     * `reason` column the day's listing never reads (AG-072, AG-074): the line
     * this module draws is by column and not by row, so a block shows its
     * interval and not its motive. Demanding a reason nobody can read on
     * screen would be asking for typing that helps no one.
     */
    reason: z
      .string()
      .trim()
      .max(512, 'El motivo no puede superar 512 caracteres')
      .optional(),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    // AG-022 at the boundary. `agenda_entry_time_order` says it again in the
    // base; this is what turns it into a message about the box to correct.
    error: 'La hora de fin debe ser posterior a la de inicio',
    path: ['endsAt'],
  });
/** Body of POST /agenda/sites/:siteId/blocks. */
export class BlockAgendaDto extends createZodDto(blockAgendaSchema) {}

/**
 * AG-040 to AG-044: one transition of one appointment.
 *
 * `to` IS an enum here, unlike `bookingChannel` above, and the asymmetry is
 * reasoned: AG-034 names the code the channel must answer with, so the domain
 * must be the one refusing it. No requirement names a code for an unknown
 * TARGET status — an unlisted `to` is a malformed request, not a state
 * conflict, and the generic per-field 422 is the honest answer. `BOOKED` and
 * `BLOCKED` are not offered: nothing returns to BOOKED, and BLOCKED belongs
 * to blocks alone (AG-046).
 */
export const transitionStatusSchema = z
  .object({
    to: z.enum(
      [
        'CONFIRMED',
        'CHECKED_IN',
        'IN_PROGRESS',
        'FULFILLED',
        'CANCELLED',
        'NO_SHOW',
        // AG-116, AG-117. Which of the two is admissible FROM WHERE is the
        // status machine's decision, not this schema's: it is a state
        // conflict (409) and not a malformed body.
        'LEFT_WITHOUT_BEING_SEEN',
        'ENTERED_IN_ERROR',
      ],
      { error: 'Indique el estado al que pasa la cita' },
    ),
    /**
     * Free text a receptionist types; it can carry health data, so it is
     * stored (history `note`, and `cancellation_note` on an annulment) and
     * never logged nor served back in listings (AG-074).
     */
    reason: z
      .string()
      .trim()
      .max(512, 'El motivo no puede superar 512 caracteres')
      .optional(),
    /**
     * AG-128, Ley 77 art. 10. The emergency call, on the arrival and nowhere
     * else. NO DEFAULT: a box that is born «no» and can be left alone proves
     * that nobody touched it, not that anybody assessed anything.
     */
    emergency: z.boolean().optional(),
    /**
     * AG-128. What whoever made the call wrote. Free text about a patient's
     * condition: stored, never logged, never served back (AG-074).
     */
    emergencyNote: z
      .string()
      .trim()
      .max(500, 'La nota no puede superar 500 caracteres')
      .optional(),
    /**
     * AG-131, Ley 77 art. 9. Why coverage was not verified.
     *
     * OPTIONAL, AND NOTHING IN THIS SCHEMA MAKES ANY PAYMENT FIELD REQUIRED —
     * that absence IS the requirement. Art. 9 forbids demanding a cheque, a
     * card or any document of payment as a condition of being received and
     * stabilised, so a body that could not be sent without one would be
     * illegal in exactly the case that matters most.
     */
    coverageCheckSkippedReason: z
      .string()
      .trim()
      .max(500, 'El motivo no puede superar 500 caracteres')
      .optional(),
  })
  .superRefine((value, ctx) => {
    // AG-044: an annulment without a reason is refused PER FIELD, so the
    // form knows exactly which box to highlight.
    if (value.to === 'CANCELLED' && !value.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Indique el motivo de la anulación',
      });
    }
    /**
     * AG-117, and per field for the same reason.
     *
     * AG-116 IS NOT HERE, AND ITS ABSENCE IS DELIBERATE: the reason for
     * leaving without being seen is OPTIONAL. Whoever walked out does not
     * always say why — that is precisely the case — and a mandatory box
     * nobody can fill truthfully gets filled with anything. The constancy
     * that matters is the history row: who marked it and when (AG-004).
     */
    if (value.to === 'ENTERED_IN_ERROR' && !value.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Indique por qué la cita se registró por error',
      });
    }
    /**
     * AG-128. The arrival carries the call or it is not recorded.
     *
     * `undefined` AND NOT FALSY: `false` is the ordinary answer and has to be
     * recordable, because «se calificó y no era una emergencia» is the half
     * of art. 10 that proves the call was made at all.
     */
    if (value.to === 'CHECKED_IN' && value.emergency === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['emergency'],
        message: 'Indique sí o no: la calificación es obligatoria al llegar',
      });
    }
  });
/** Body of POST /agenda/sites/:siteId/entries/:entryId/status. */
export class TransitionStatusDto extends createZodDto(transitionStatusSchema) {}

export const agendaEntrySchema = z.object({
  id: z.uuid(),
  kind: KIND,
  siteId: z.uuid(),
  practitionerId: z.uuid(),
  roomId: z.uuid().nullable(),
  /** `null` on a block, which has no patient (AG-021). */
  patientId: z.uuid().nullable(),
  /**
   * Filing order («Andrade, Rosa»), for the calendar card. Identification is
   * operational; the REASON stays out of the listing (AG-072/074).
   */
  patientName: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: STATUS,
  /** AG-036: `false` is a deliberate overbooking, distinguishable without a second call. */
  blocksCalendar: z.boolean(),
  /**
   * AG-036. The other half of «distinguirlo sin consultar otra vez»: WHY the
   * grid was broken, and WHO said it could be.
   *
   * PRESENT ON EVERY ROW AND NOT ONLY ON THE OVERBOOKINGS — `null` elsewhere —
   * because a field that appears only sometimes is a field clients forget to
   * read. What makes serving it safe is that it is a COLUMN OF ITS OWN: this
   * is administrative text, and the free text where recepción may write a
   * motive for the visit (`reason`) is still not in this response and will not
   * be (AG-072, AG-074, SC-006).
   */
  overbookingReason: z.string().nullable(),
  overbookingAuthorisedById: z.uuid().nullable(),
  /**
   * AG-018. Present on every row, not only on the released ones: a client that
   * asked for them has to be able to tell which is which, and a field that
   * appears only sometimes is a field that gets forgotten.
   */
  releasedAt: z.iso.datetime().nullable(),
  /** AG-041. The real instant of arrival, `null` until it happens. */
  checkedInAt: z.iso.datetime().nullable(),
  /**
   * AG-118. `checkedInAt − startsAt` in minutes, WITH ITS SIGN — negative
   * means the patient arrived early — and `null` while nobody has arrived.
   *
   * COMPUTED ON EVERY READ AND STORED NOWHERE, which is the property that
   * keeps it true. It is also why late arrival is not a status: a stored copy
   * of this subtraction would age, and `CHECKED_IN` would have to be true at
   * the same time as `LATE_ARRIVAL`.
   */
  arrivalDelayMinutes: z.number().int().nullable(),
  /**
   * AG-121. Where the PATIENT is, and when they got there — a different axis
   * from `status`, never derived from it nor it from this. Both `null` before
   * the arrival (AG-127) and on every block (AG-021).
   */
  subjectStatus: SUBJECT_STATUS.nullable(),
  subjectStatusAt: z.iso.datetime().nullable(),
  /**
   * AG-128, Ley 77 art. 10. That the emergency call was made at the arrival,
   * and separately whether it came out affirmative.
   *
   * TWO FIELDS, because one cannot tell «se calificó y no era una emergencia»
   * from «nadie calificó nada», and proving the second is the whole of art.
   * 10. The NOTE is not served: it is free text about a patient's condition
   * and this response is read by anyone with `agenda:read` over the site,
   * with no row in `access_audit` (AG-072, AG-074).
   */
  emergencyAssessedAt: z.iso.datetime().nullable(),
  emergencyFlaggedAt: z.iso.datetime().nullable(),
  bookingChannel: BOOKING_CHANNEL.nullable(),
  /** SP-028: the type recepción chose, `service_type.id`. */
  serviceTypeId: z.uuid().nullable(),
  /**
   * NO `reason` IN THE RESPONSE (AG-072, AG-074, SC-006). It is accepted on
   * the way in and stored; it is not served back, because the day's list is
   * read by anyone with `agenda:read` over the site and leaves no row in
   * `access_audit`.
   *
   * AG-036 NEEDED THE REASON OF AN OVERBOOKING, and it did NOT come back
   * through this door: E4 gave it a column of its own
   * (`overbookingReason`, above). Serving `reason` «only when it is an
   * overbooking» would have been conditional exposure of PHI — nothing stops
   * the same text being written there — and a condition in a serialiser is not
   * a guarantee.
   */
  createdById: z.uuid().nullable(),
  /**
   * AG-051. The other end of a reschedule, in BOTH directions.
   *
   * IDENTIFIERS AND NOT AN EMBEDDED ENTRY: nesting a whole appointment inside
   * another would put a second copy of every field into the response, and the
   * two would age differently. A client that needs the other one lists its day.
   *
   * `rescheduledFromId` is the stored column; `rescheduledToId` is that same
   * column read backwards through `agenda_entry_one_reschedule_per_entry`.
   * Both `null` on an appointment booked directly and never moved, which is
   * almost every one of them.
   */
  rescheduledFromId: z.uuid().nullable(),
  rescheduledToId: z.uuid().nullable(),
});
/** One entry as every listing serves it; also the response of creating and releasing a block. */
export class AgendaEntryDto extends createZodDto(agendaEntrySchema) {}

/**
 * AG-110. The appointment that was created, plus what is worth saying about it.
 *
 * THE WARNINGS RIDE IN A 201 AND NEVER IN A PROBLEM DOCUMENT. Present and
 * empty when there is nothing to say; never a refusal. The booking already
 * happened when this travels — a holiday does not block it, because a clinic
 * with A&E works the 25th of December and refusing would only push that case
 * out of the system (D-019, the reasoning of D-005).
 *
 * SENTENCES AND NOT CODES, like `RolePermissions.warnings` of `auth`
 * (AU-034): the text names a holiday an administrator typed in freely, so
 * there is nothing stable for a client to branch on and inventing a code would
 * mean maintaining a second vocabulary for rows nobody enumerates.
 *
 * ONLY ON THE BOOKING RESPONSE, not on `AgendaEntryDto`: a warning is about a
 * change somebody is making, and carrying it on every listed row would train
 * people to ignore it (the same line `auth` draws between reading a role and
 * saving one).
 */
export const bookedAppointmentSchema = agendaEntrySchema.extend({
  warnings: z.array(z.string()).readonly(),
});
/** Response of POST /agenda/sites/:siteId/entries. */
export class BookedAppointmentDto extends createZodDto(
  bookedAppointmentSchema,
) {}

/**
 * AG-118, AG-119. What a status change answers with.
 *
 * THE SAME SHAPE AS A BOOKING, and for the same reason: the warning rides in
 * the 200 and never in a problem document. AG-119 says so in as many words —
 * the late arrival is warned about and the check-in is NOT refused — and the
 * reason is AG-128: the arrival is the moment Ley 77 art. 10 obliges the
 * emergency call to be made, so a check-in that can be rejected is a check-in
 * that some day does not happen, and with it goes the assessment art. 13 backs
 * with prison. What the clinic's policy decides is what happens afterwards
 * (AG-120), not whether the person at the counter is recorded as having come.
 *
 * NO ERROR CODE ON THE WARNING, because it is not an error — exactly like the
 * holiday warning of AG-110.
 */
export const transitionOutcomeSchema = agendaEntrySchema.extend({
  warnings: z.array(z.string()).readonly(),
});
/** Response of POST /agenda/sites/:siteId/entries/:entryId/status. */
export class TransitionOutcomeDto extends createZodDto(
  transitionOutcomeSchema,
) {}

/**
 * AG-050, AG-115. What moving one appointment needs to be told.
 *
 * THE PATIENT AND THE ROOM ARE NOT HERE, and that is not an omission: they are
 * copied from the stored row, so no body can turn «reprogramar» into a way of
 * handing one person's hour to another with one field.
 *
 * THE PROFESSIONAL AND THE TYPE OF ATTENTION *ARE* HERE SINCE AG-115, and both
 * are OPTIONAL: absent means the one the appointment already had, which is how
 * this endpoint behaved before and still behaves for the nine reschedules out
 * of ten that only move the hour. They may be chosen because AG-050 creates a
 * NEW row — they are columns of something being born, not an edit of the
 * appointment that exists. Refusing them would not stop the case: recepción
 * would annul and book again, and that loses the link AG-051 builds and reports
 * an annulment to AG-080 that never was one.
 *
 * THE CHANNEL IS ASKED FOR because the reschedule was requested however it was
 * requested — by telephone, at the counter — and AG-080 reports by channel.
 * Inheriting the original's would report a call that never happened.
 */
export const rescheduleAppointmentSchema = z.object({
  startsAt: instant('La nueva hora de inicio'),
  endsAt: instant('La nueva hora de fin'),
  /** AG-029, AG-034: a string, so the domain answers `INVALID_BOOKING_CHANNEL`. */
  bookingChannel: z.string({ error: 'Indique cómo se solicitó el cambio' }),
  /**
   * AG-115. Who will attend it now. The same checks a booking gets are then
   * run against HIM (AG-028, AG-031 to AG-033, and the three `EXCLUDE`).
   */
  practitionerId: z.uuid('Seleccione un profesional válido').optional(),
  /** AG-115, SP-028. The type of attention of the new appointment. */
  serviceTypeId: z.uuid('Seleccione un tipo de atención válido').optional(),
  /**
   * AG-115. THE PATIENT IS REFUSED OUT LOUD, not stripped in silence.
   *
   * «Una cita de otra persona no es una reprogramación»: the field exists here
   * only so that a client that sends one is told, per field and in Spanish,
   * instead of watching the appointment move with the patient it always had —
   * which reads on screen exactly like a change that worked.
   */
  patientId: z
    .never({
      error:
        'La reprogramación no cambia de paciente. Reserve una cita nueva a su nombre',
    })
    .optional(),
  /**
   * AG-044. REQUIRED, unlike the reason of a booking: the entry that exists is
   * annulled by this operation, and «anular con rastro» is worth nothing if
   * the rastro can be empty. Refused per field, so the form knows which box to
   * highlight before the domain says the same thing.
   */
  reason: z
    .string()
    .trim()
    .min(1, 'Indique el motivo de la reprogramación')
    .max(512, 'El motivo no puede superar 512 caracteres'),
});
/** Body of POST /agenda/sites/:siteId/entries/:entryId/reschedule. */
export class RescheduleAppointmentDto extends createZodDto(
  rescheduleAppointmentSchema,
) {}

/**
 * AG-050, AG-051. The pair one reschedule leaves behind.
 *
 * BOTH ENTRIES TRAVEL BACK, and that is what makes AG-051 visible to a client
 * instead of only true in the database: `original` comes back annulled and
 * released with `rescheduledToId` pointing at the new one, and `created` comes
 * back with `rescheduledFromId` pointing back. Neither has to be looked up.
 *
 * `warnings` is AG-110, exactly as the booking response carries it: present,
 * usually empty, and never a refusal — the entry already exists by then.
 */
export const rescheduledAppointmentSchema = z.object({
  original: agendaEntrySchema,
  created: agendaEntrySchema,
  warnings: z.array(z.string()).readonly(),
});
/** Response of the reschedule route. */
export class RescheduledAppointmentDto extends createZodDto(
  rescheduledAppointmentSchema,
) {}

/**
 * AG-010. Which practitioner, at which site, over which range of dates.
 *
 * THE RANGE IS BOUNDED AT THE BOUNDARY. `clinicalDatesBetween` already refuses
 * more than `MAX_RANGE_DAYS` with a `RangeError`, which is the right guarantee
 * for every caller but the wrong answer over HTTP: an unhandled `RangeError`
 * reaches the client as a 500, as if the server had broken, when what happened
 * is that somebody mistyped a year. Refusing it here turns it into a 422 that
 * names the field to correct. The number is imported, not copied: two
 * independent limits is one limit that eventually disagrees with itself.
 *
 * THE SITE IS NOT HERE either: it is the `:siteId` of the route, so the guard
 * can check the caller's scope before any pipe runs (AG-071).
 */
export const availabilityQuerySchema = z
  .object({
    practitionerId: z.uuid('Seleccione un profesional de la lista'),
    from: clinicalDateField('Indique la fecha inicial en formato AAAA-MM-DD'),
    to: clinicalDateField('Indique la fecha final en formato AAAA-MM-DD'),
  })
  .refine((query) => clinicalDaySpan(query.from, query.to) > 0, {
    error: 'La fecha final no puede ser anterior a la inicial',
    path: ['to'],
  })
  .refine((query) => clinicalDaySpan(query.from, query.to) <= MAX_RANGE_DAYS, {
    error: `El rango no puede superar ${MAX_RANGE_DAYS} días`,
    path: ['to'],
  });
/** Query of GET /agenda/sites/:siteId/availability. */
export class AvailabilityQueryDto extends createZodDto(
  availabilityQuerySchema,
) {}

/**
 * A derived slot. It carries no identifier because it is not a row (AG-003).
 *
 * `ruleId` is the rule it comes from, which is what lets a client group a day
 * by schedule and what makes an offered slot explainable — "this hole exists
 * because of that rule" — without a second call.
 */
export const availabilitySlotSchema = z.object({
  ruleId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** D-021: the site's atom, which is what every slot now lasts. */
  slotMinutes: z.number().int().positive(),
  /**
   * `practitioner_schedule_rule.service_type_concept_id`, a concept of the MSP
   * CLINICAL catalogue — and NOT the same thing as the appointment's
   * `serviceTypeId`, which since C4 is the clinic's own `service_type`
   * (SP-020). The two names differ because the two identities differ: sending
   * this one as a booking's `serviceTypeId` would name a row of another table.
   *
   * The column is not written by any route today (ST-04x never sets it), so
   * this is `null` on every slot. It was deliberately left alone in C4 — see
   * the note on the schedule rule in `specialties/SPEC.md`.
   */
  serviceTypeConceptId: z.uuid().nullable(),
});

/**
 * A stretch of the range that is already taken.
 *
 * WHEN, AND NOTHING ELSE (AG-074, SC-006). Recepción needs to see the hole and
 * how long the occupied stretch lasts in order to place a patient; it does not
 * need the name, the chart number or the reason for the visit to do that, and
 * neither does the screen that paints the day. Not even the entry's identifier
 * travels: without it this answer cannot be joined against anything to work
 * out who holds which hour. Whoever has to act on an entry lists the agenda of
 * the day, which is a separate route with its own permission.
 *
 * Everything listed here occupies the calendar by definition — the released
 * and the overbooked are not in it — so there is no flag to read.
 */
export const occupiedIntervalSchema = z.object({
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});

/**
 * AG-015. A date that offers nothing because the site observes a holiday, and
 * the reason to show for it.
 *
 * THE REASON IS THE NAME OF THE HOLIDAY and it is a Spanish sentence fragment
 * a receptionist reads, not a stable code: there is nothing for a client to
 * branch on here, and inventing a code would mean maintaining a second
 * vocabulary for rows an administrator types in freely.
 */
export const closedDateSchema = z.object({
  date: z.iso.date(),
  /** «Navidad», «Primer Grito de Independencia». */
  reason: z.string(),
});

export const availabilitySchema = z.object({
  siteId: z.uuid(),
  practitionerId: z.uuid(),
  /** Echoed so the client never has to remember what it asked for. */
  from: z.iso.date(),
  to: z.iso.date(),
  /** Free slots, ordered by instant. Derived, never stored (AG-003). */
  slots: z.array(availabilitySlotSchema),
  /**
   * AG-011: what is taken AT THIS SITE, including entries booked under expired
   * rules. Since AG-144 a slot can be missing from both `slots` and this list:
   * the practitioner is taken elsewhere, and that is `unavailable`.
   */
  occupied: z.array(occupiedIntervalSchema),
  /**
   * AG-145. When the practitioner is taken at ANOTHER site: two instants per
   * stretch, merged and clipped to the range — no site, no reason, no patient,
   * no kind of entry (AG-107). A client paints it «No disponible» and never
   * reads it as «sin horario».
   */
  unavailable: z.array(occupiedIntervalSchema),
  /**
   * AG-015, AG-016. The dates of the range with no slots on offer, and why.
   *
   * A date listed here has no slot in `slots`, and the pairing is the point:
   * a screen that only saw the missing slots would say «este profesional no
   * atiende ese día» about a national holiday.
   */
  closedDates: z.array(closedDateSchema),
  /**
   * AG-093. Years of the range whose holiday calendar is not loaded.
   *
   * The slots of those dates ARE in `slots`: the answer is given and the doubt
   * is stated with it. Empty is the ordinary case and means nothing is
   * pending — never that the years have no holidays.
   */
  yearsWithoutCalendar: z.array(z.number().int()),
});
/** Response of GET /agenda/sites/:siteId/availability. */
export class AvailabilityDto extends createZodDto(availabilitySchema) {}

/**
 * SP-028. What recepción has picked so far, when it asks how long the
 * appointment would last.
 *
 * THE SITE IS NOT HERE: it is the `:siteId` of the route, so the guard settles
 * the caller's scope before any pipe runs (AG-071), like every other route of
 * this controller.
 */
export const durationProposalQuerySchema = z.object({
  practitionerId: z.uuid('Seleccione un profesional de la lista'),
  /**
   * The instant the appointment would start. It decides which schedule rule is
   * open (AG-010, AG-106), which is SP-023's third rung.
   */
  startsAt: instant('La hora de inicio'),
  /** Absent until recepción chooses a type: the rule's slot then answers. */
  serviceTypeId: z.uuid('Seleccione un tipo de atención válido').optional(),
});
/** Query of GET /agenda/sites/:siteId/duration. */
export class DurationProposalQueryDto extends createZodDto(
  durationProposalQuerySchema,
) {}

export const durationProposalSchema = z.object({
  /**
   * SP-023: excepción → duración base → turno de la sede.
   *
   * D-021 REMOVED THE SECOND FIELD, `slotMinutes`. It carried the grid so the
   * screen could warn «no encaja en los turnos de N min» before the click,
   * back when a duration could be saved that the very next booking refused.
   * Every duration is now a multiple of the site's atom by the time it can be
   * saved, so the warning can no longer fire — and one that never fires only
   * teaches people to skip the ones that do.
   */
  minutes: z.number().int().positive().nullable(),
});
/** Response of GET /agenda/sites/:siteId/duration, and the type the controller returns for it. */
export class DurationProposalDto extends createZodDto(durationProposalSchema) {}
export type DurationProposalResponse = z.infer<typeof durationProposalSchema>;

export const dailyAgendaSchema = z.object({
  siteId: z.uuid(),
  date: z.iso.date(),
  /** Ordered by start instant (AG-017). */
  items: z.array(agendaEntrySchema),
  /** Echoed so the client never has to remember what it asked for. */
  includeReleased: z.boolean(),
});
/** Response of GET /agenda/sites/:siteId/entries. */
export class DailyAgendaDto extends createZodDto(dailyAgendaSchema) {}

/**
 * The response types the controller must return, inferred from the SAME
 * schemas Swagger publishes. This is the verifier the contract was missing:
 * with `Promise<unknown>` a field could leave the response — as `user` once
 * left the refresh response — and nothing would notice. Now the compiler does.
 */
export type DailyAgendaResponse = z.infer<typeof dailyAgendaSchema>;
export type AvailabilityResponse = z.infer<typeof availabilitySchema>;
export type AgendaEntryResponse = z.infer<typeof agendaEntrySchema>;
export type BookedAppointmentResponse = z.infer<typeof bookedAppointmentSchema>;
export type TransitionOutcomeResponse = z.infer<typeof transitionOutcomeSchema>;
export type RescheduledAppointmentResponse = z.infer<
  typeof rescheduledAppointmentSchema
>;

/** AG-107. A site the caller may schedule in. */
export const agendaSiteSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});
/** One row of `AgendaSitesDto`; no route returns it on its own. */
export class AgendaSiteDto extends createZodDto(agendaSiteSchema) {}

export const agendaSitesSchema = z.object({
  items: z.array(agendaSiteSchema).readonly(),
});
/** Response of GET /agenda/sites (AG-107). */
export class AgendaSitesDto extends createZodDto(agendaSitesSchema) {}

/**
 * AG-111, SP-005, SP-008. A specialty the practitioner holds, as the booking
 * dialog needs it.
 *
 * NO `code` AND NO `active`. The stable code (SP-001) is what the record, the
 * invoice and the RDACAA carry, and no dropdown needs it; only active ones are
 * listed, so a flag that is always `true` would only invite filtering on it.
 */
export const agendaSpecialtySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** SP-005: exactly one of a practitioner's specialties is the primary one. */
  isPrimary: z.boolean(),
});

/**
 * AG-108, AG-111. Name, id and the specialties this practitioner works in,
 * nothing else: the cedula and the ACESS registration travel in signed
 * documents, not in a dropdown anyone with `agenda:read` can open.
 */
export const schedulablePractitionerSchema = z.object({
  id: z.uuid(),
  /** Account id: lets the interface preselect the signed-in doctor's column. */
  userId: z.uuid(),
  fullName: z.string(),
  /**
   * AG-111. Active only (SP-004), primary first. Empty is an ordinary answer
   * — a practitioner nobody assigned a specialty to — and not an error.
   */
  specialties: z.array(agendaSpecialtySchema).readonly(),
});
/** One row of `SchedulablePractitionersDto`; no route returns it on its own. */
export class SchedulablePractitionerDto extends createZodDto(
  schedulablePractitionerSchema,
) {}

export const schedulablePractitionersSchema = z.object({
  items: z.array(schedulablePractitionerSchema).readonly(),
});
/** Response of GET /agenda/sites/:siteId/practitioners. */
export class SchedulablePractitionersDto extends createZodDto(
  schedulablePractitionersSchema,
) {}

/**
 * AG-112. An attention type for the booking dialog: what to show, how long it
 * lasts in the catalogue, and the id the booking will carry (SP-028).
 *
 * `durationMinutes` IS THE CATALOGUE'S BASE, not the appointment's duration.
 * The one that gets booked comes from `GET …/duration`, which applies SP-023
 * whole — the practitioner's own exception wins over this number. Sending it
 * here saves one request per option in a dropdown; it does not compute an end
 * time, and nothing in this response should be used to.
 */
export const agendaServiceTypeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  durationMinutes: z.number().int().positive(),
});

export const agendaServiceTypesSchema = z.object({
  items: z.array(agendaServiceTypeSchema).readonly(),
});
/** Response of GET /agenda/sites/:siteId/specialties/:specialtyId/service-types. */
export class AgendaServiceTypesDto extends createZodDto(
  agendaServiceTypesSchema,
) {}

/**
 * AG-080, AG-081. The period the inasistencia rate is asked over.
 *
 * ECUADORIAN CALENDAR DATES, inclusive at both ends, and NOT two instants:
 * «del 1 al 30 de septiembre» is what a clinic asks, and an instant would make
 * the answer depend on the hour the question was asked at. The service turns
 * them into `[00:00, 24:00)` in `America/Guayaquil` (AG-001) and closes the
 * window at the present moment (AG-081).
 *
 * THE SAME TWO GUARDS AS AVAILABILITY, and for the same reasons: a backwards
 * range is a typo, and a range of four wrong digits in a year must be refused
 * politely here rather than counted.
 */
export const noShowMetricQuerySchema = z
  .object({
    from: clinicalDateField('Indique la fecha inicial en formato AAAA-MM-DD'),
    to: clinicalDateField('Indique la fecha final en formato AAAA-MM-DD'),
  })
  .refine((query) => clinicalDaySpan(query.from, query.to) > 0, {
    error: 'La fecha final no puede ser anterior a la inicial',
    path: ['to'],
  })
  .refine((query) => clinicalDaySpan(query.from, query.to) <= MAX_RANGE_DAYS, {
    error: `El rango no puede superar ${MAX_RANGE_DAYS} días`,
    path: ['to'],
  });
/** Query of GET /agenda/metrics/no-show. */
export class NoShowMetricQueryDto extends createZodDto(
  noShowMetricQuerySchema,
) {}

/**
 * AG-080, AG-081. A rate, and the two numbers it is made of.
 *
 * THE DENOMINATOR TRAVELS WITH THE PERCENTAGE, always. «50 %» over two
 * appointments and over four hundred are the same number and not the same
 * fact, and a screen given only the first cannot tell the reader which one it
 * is looking at.
 */
const noShowRateFields = {
  /** Appointments marked `NO_SHOW`. */
  noShow: z.number().int().nonnegative(),
  /**
   * AG-140. Of `total`, those who came and left before being seen.
   *
   * OUT OF THE NUMERATOR, INSIDE THE DENOMINATOR, AND COUNTED ON ITS OWN. They
   * had an appointment and they did reach their hour, so removing them would
   * shrink the total the rate is measured over and improve the clinic's figure
   * for the sole reason that people got tired of waiting. It travels with the
   * same three breakdowns because it is what the clinic acts on — the user
   * asked for this as A METRIC TO REDUCE.
   */
  leftWithoutBeingSeen: z.number().int().nonnegative(),
  /** AG-081: reached their hour and were not annulled. */
  total: z.number().int().nonnegative(),
  /** Of `total`, those whose outcome nobody recorded. */
  pending: z.number().int().nonnegative(),
  /**
   * `noShow / total`, four decimals, `null` when there were no appointments.
   * Never `0` for «no hubo citas» — see `no-show-metric.ts`.
   */
  rate: z.number().min(0).max(1).nullable(),
};

export const noShowBySiteSchema = z.object({
  siteId: z.uuid(),
  siteName: z.string(),
  ...noShowRateFields,
});

export const noShowByPractitionerSchema = z.object({
  practitionerId: z.uuid(),
  practitionerName: z.string(),
  ...noShowRateFields,
});

export const noShowByChannelSchema = z.object({
  bookingChannel: BOOKING_CHANNEL,
  ...noShowRateFields,
});

/**
 * AG-080. One calculation and its three cuts, in one answer.
 *
 * The range travels back with it because the server narrowed it: what was
 * asked for and what was counted differ whenever the period reaches into the
 * future (AG-081), and a screen that repeated the user's own dates would be
 * labelling the figure with a period it was not computed over.
 */
export const noShowMetricSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  /** The last instant included, after AG-081 closed the window at «now». */
  countedUntil: z.iso.datetime(),
  overall: z.object(noShowRateFields),
  bySite: z.array(noShowBySiteSchema).readonly(),
  byPractitioner: z.array(noShowByPractitionerSchema).readonly(),
  byChannel: z.array(noShowByChannelSchema).readonly(),
});
/** Response of GET /agenda/metrics/no-show. */
export class NoShowMetricDto extends createZodDto(noShowMetricSchema) {}

/** What the metrics controller returns, inferred from the schema Swagger publishes. */
export type NoShowMetricResponse = z.infer<typeof noShowMetricSchema>;

/** What the reference routes return, inferred from the schemas Swagger publishes. */
export type AgendaSitesResponse = z.infer<typeof agendaSitesSchema>;
export type SchedulablePractitionersResponse = z.infer<
  typeof schedulablePractitionersSchema
>;
/** Likewise, for the attention types of a specialty. */
export type AgendaServiceTypesResponse = z.infer<
  typeof agendaServiceTypesSchema
>;

// --- Lista de espera (E5: AG-060 a AG-067) ---------------------------------

const WAITLIST_STATUS = z.enum([
  'WAITING',
  'CONTACTED',
  'SCHEDULED',
  'EXPIRED',
  'CANCELLED',
]);

/** AG-064. Qué pasó en la llamada; los tres cierran el cupo de forma distinta. */
const CONTACT_OUTCOME = z.enum(['NO_ANSWER', 'ACCEPTED', 'DECLINED']);

/**
 * AG-060. Inscribir a quien se quedó sin cupo.
 *
 * LA SEDE NO VA EN EL CUERPO: es el `:siteId` de la ruta, para que el guard
 * compruebe el alcance antes de que corra ningún pipe (AG-071).
 *
 * EL RANGO ES OBLIGATORIO Y EL RESTO NO. Sin fecha máxima, AG-065 no se cumple
 * nunca y la entrada compite por cada cupo de la sede para siempre; el
 * profesional y el tipo de atención en cambio son lo único que AG-060 declara
 * opcional, y omitirlos significa «cualquiera», no «ninguno».
 */
export const enrolInWaitlistSchema = z
  .object({
    patientId: z.uuid('Seleccione el paciente que espera'),
    preferredFrom: clinicalDateField(
      'Indique desde qué fecha le sirve la cita, en formato AAAA-MM-DD',
    ),
    preferredTo: clinicalDateField(
      'Indique hasta qué fecha le sirve la cita, en formato AAAA-MM-DD',
    ),
    practitionerId: z.uuid('Seleccione un profesional de la lista').optional(),
    /**
     * AG-060, AG-061. EL MISMO CATÁLOGO QUE NOMBRA LA CITA: `service_type`,
     * desde `waitlist_service_type_follows_agenda`.
     *
     * La columna apuntaba a `catalog_concept` mientras
     * `agenda_entry.service_type_id` apuntaba a `service_type` desde C4, y con
     * dos tablas distintas la mitad de AG-061 que compara los dos tipos no
     * podía ser cierta nunca: el campo sólo habría servido para rechazar por
     * clave foránea todo identificador legítimo. Por eso no se admitió al
     * cerrar E5, y por eso se admite ahora.
     *
     * OMITIRLO SIGNIFICA «CUALQUIERA», no «ninguno»: una entrada sin tipo
     * encaja en cualquier cupo del rango, y una que lo fija sólo en los suyos.
     */
    serviceTypeId: z.uuid('Seleccione un tipo de atención válido').optional(),
  })
  .refine((value) => value.preferredTo >= value.preferredFrom, {
    // Inclusivo por los dos lados: «del 3 al 3» es un rango legítimo — la
    // paciente sólo puede ese día. Lo mismo que dice
    // `waitlist_entry_preferred_range_valid`.
    path: ['preferredTo'],
    message: 'La fecha final no puede ser anterior a la inicial',
  });
/**
 * ⚠️ NO HAY TOPE DE LONGITUD DEL RANGO, y quitarlo fue deliberado.
 *
 * La primera versión rechazaba más de un año, reutilizando `MAX_RANGE_DAYS`,
 * que existe para acotar CONSULTAS. Aquí no acota una consulta: decide cuánto
 * tiempo puede una persona seguir esperando un cupo, que es política de la
 * clínica y no la decide un agente (D-040 no la pregunta y nadie la ha
 * contestado). Lo que sí impide que una entrada espere para siempre es AG-065,
 * que necesita una fecha máxima y ya la exige.
 */
export class EnrolInWaitlistDto extends createZodDto(enrolInWaitlistSchema) {}

/** AG-064. */
export const recordContactAttemptSchema = z.object({
  outcome: CONTACT_OUTCOME,
});
/** Body of POST /agenda/sites/:siteId/waitlist/:entryId/contact-attempts. */
export class RecordContactAttemptDto extends createZodDto(
  recordContactAttemptSchema,
) {}

/**
 * AG-063. La cita YA CREADA con la que se cierra la inscripción.
 *
 * La cita se reserva por la ruta de siempre y esto la enlaza: AG-063 dice qué
 * le pasa a la ENTRADA, no cómo nace la cita, y reservarla aquí sería un
 * segundo camino a través de AG-020 a AG-034.
 */
export const convertWaitlistEntrySchema = z.object({
  appointmentId: z.uuid('Seleccione la cita creada para este paciente'),
});
/** Body of POST /agenda/sites/:siteId/waitlist/:entryId/conversion. */
export class ConvertWaitlistEntryDto extends createZodDto(
  convertWaitlistEntrySchema,
) {}

/**
 * Una inscripción, como la devuelve toda ruta de E5.
 *
 * NI NOMBRE NI MOTIVO (AG-072, AG-074, SC-006): el identificador de la ficha y
 * nada más. La pantalla que necesite el nombre se lo pide al registro de
 * pacientes, y esa petición es la que deja fila en la bitácora (AG-073).
 *
 * `contactAttempts` y `lastContactedAt` se DERIVAN del rastro de llamadas: las
 * dos columnas que decían esto a medias se fueron con
 * `agenda_waitlist_contact_trail`.
 */
export const waitlistEntrySchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  practitionerId: z.uuid().nullable(),
  serviceTypeId: z.uuid().nullable(),
  preferredFrom: z.iso.date(),
  preferredTo: z.iso.date(),
  status: WAITLIST_STATUS,
  /** AG-063. La cita en que se convirtió, o `null`. */
  convertedEntryId: z.uuid().nullable(),
  contactAttempts: z.number().int().nonnegative(),
  lastContactedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
/** Response of enrolling, recording a contact attempt and converting. */
export class WaitlistEntryDto extends createZodDto(waitlistEntrySchema) {}

/**
 * Una candidata, con el número por el que se ordena.
 *
 * ⚠️ `priority` ES `1` o `2` Y NO DICE POR QUÉ (PA-042, AG-073). Se deriva en
 * el instante de proponer a partir de los grupos vigentes hoy — la columna que
 * lo congelaba se quitó — y el motivo tiene su propio permiso, su propia fila
 * de bitácora y no viaja en ningún listado.
 */
export const waitlistCandidateSchema = z.object({
  entryId: z.uuid(),
  patientId: z.uuid(),
  /** `1` prioritario por el artículo 35, `2` corriente. */
  priority: z.union([z.literal(1), z.literal(2)]),
  status: WAITLIST_STATUS,
  /** AG-061. La antigüedad de inscripción, que es el segundo criterio. */
  enrolledAt: z.iso.datetime(),
  practitionerId: z.uuid().nullable(),
  serviceTypeId: z.uuid().nullable(),
  preferredFrom: z.iso.date(),
  preferredTo: z.iso.date(),
  contactAttempts: z.number().int().nonnegative(),
  lastContactedAt: z.iso.datetime().nullable(),
});
/** One ranked candidate; the waitlist controller's `toCandidateResponse` returns this type. */
export class WaitlistCandidateDto extends createZodDto(
  waitlistCandidateSchema,
) {}

/** AG-062, AG-065, AG-067. La lista de espera abierta de una sede, en orden. */
export const waitlistSchema = z.object({
  siteId: z.uuid(),
  items: z.array(waitlistCandidateSchema).readonly(),
});
/** Response of GET /agenda/sites/:siteId/waitlist. */
export class WaitlistDto extends createZodDto(waitlistSchema) {}

/**
 * AG-061. A quién se le ofrece el cupo que acaba de liberarse.
 *
 * EL CUPO VIAJA EN LA RESPUESTA porque lo derivó el servidor de la entrada
 * liberada, no el cliente: quien llama tiene que poder decirle al paciente qué
 * hora se le está ofreciendo, y repetir lo que él mismo envió sería etiquetar
 * la lista con un horario que nadie comprobó.
 */
export const waitlistCandidatesSchema = z.object({
  siteId: z.uuid(),
  releasedEntryId: z.uuid(),
  slot: z.object({
    date: z.iso.date(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    practitionerId: z.uuid(),
    serviceTypeId: z.uuid().nullable(),
  }),
  items: z.array(waitlistCandidateSchema).readonly(),
});
/** Response of GET /agenda/sites/:siteId/waitlist/candidates/:releasedEntryId. */
export class WaitlistCandidatesDto extends createZodDto(
  waitlistCandidatesSchema,
) {}

/** What the waitlist controller returns, inferred from the schemas Swagger publishes. */
export type WaitlistEntryResponse = z.infer<typeof waitlistEntrySchema>;
export type WaitlistResponse = z.infer<typeof waitlistSchema>;
export type WaitlistCandidatesResponse = z.infer<
  typeof waitlistCandidatesSchema
>;
