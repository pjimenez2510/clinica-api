import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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
]);

const BOOKING_CHANNEL = z.enum(['PHONE', 'WALK_IN', 'WEB', 'REFERRAL']);

/**
 * A flag that only `true` turns on.
 *
 * NOT `z.coerce.boolean()`, and the difference is not pedantry: coercion
 * follows JavaScript truthiness, so `?includeReleased=false` becomes `true` —
 * the string is non-empty. AG-018 says released entries are left out unless
 * they are asked for EXPLICITLY, and a flag that cannot be turned off by
 * writing `false` is not explicit at all.
 */
const explicitFlag = z
  .enum(['true', 'false'], {
    error: 'Indique verdadero o falso',
  })
  .default('false')
  .transform((value) => value === 'true');

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
export class DailyAgendaQueryDto extends createZodDto(dailyAgendaQuerySchema) {}

/**
 * AG-020: patient, practitioner, site, start and end are all required.
 *
 * THE SITE IS NOT IN THE BODY: it is the `:siteId` of the route, so the guard
 * can check the caller's scope over it before any pipe runs (AG-071). Guards
 * see route parameters and an unvalidated body, which is why an authorisation
 * decision may only be taken on the former.
 */
export const bookAppointmentSchema = z.object({
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
  serviceTypeConceptId: z.uuid('Seleccione un tipo de servicio válido').optional(), // prettier-ignore
  /**
   * Free text a receptionist types. It may carry a reason for the visit, which
   * is health data: it is stored, and it never reaches a log (AG-074).
   */
  reason: z
    .string()
    .trim()
    .max(512, 'El motivo no puede superar 512 caracteres')
    .optional(),
});
export class BookAppointmentDto extends createZodDto(bookAppointmentSchema) {}

export const agendaEntrySchema = z.object({
  id: z.uuid(),
  kind: KIND,
  siteId: z.uuid(),
  practitionerId: z.uuid(),
  roomId: z.uuid().nullable(),
  /** `null` on a block, which has no patient (AG-021). */
  patientId: z.uuid().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: STATUS,
  /** AG-036: `false` is a deliberate overbooking, distinguishable without a second call. */
  blocksCalendar: z.boolean(),
  /**
   * AG-018. Present on every row, not only on the released ones: a client that
   * asked for them has to be able to tell which is which, and a field that
   * appears only sometimes is a field that gets forgotten.
   */
  releasedAt: z.iso.datetime().nullable(),
  bookingChannel: BOOKING_CHANNEL.nullable(),
  serviceTypeConceptId: z.uuid().nullable(),
  /**
   * NO `reason` IN THE RESPONSE (AG-072, AG-074, SC-006). It is accepted on
   * the way in and stored; it is not served back, because the day's list is
   * read by anyone with `agenda:read` over the site and leaves no row in
   * `access_audit`. AG-036 will need the reason of an OVERBOOKING here — that
   * is the same column, and it needs a decision about what the listing may
   * carry, not a field quietly added back.
   */
  createdById: z.uuid().nullable(),
});
export class AgendaEntryDto extends createZodDto(agendaEntrySchema) {}

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
  slotMinutes: z.number().int().positive(),
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

export const availabilitySchema = z.object({
  siteId: z.uuid(),
  practitionerId: z.uuid(),
  /** Echoed so the client never has to remember what it asked for. */
  from: z.iso.date(),
  to: z.iso.date(),
  /** Free slots, ordered by instant. Derived, never stored (AG-003). */
  slots: z.array(availabilitySlotSchema),
  /** AG-011: what is taken, including entries booked under expired rules. */
  occupied: z.array(occupiedIntervalSchema),
});
export class AvailabilityDto extends createZodDto(availabilitySchema) {}

export const dailyAgendaSchema = z.object({
  siteId: z.uuid(),
  date: z.iso.date(),
  /** Ordered by start instant (AG-017). */
  items: z.array(agendaEntrySchema),
  /** Echoed so the client never has to remember what it asked for. */
  includeReleased: z.boolean(),
});
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
