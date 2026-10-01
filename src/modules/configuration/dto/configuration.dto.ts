import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CANCELLED_RETENTION_POLICIES } from '../domain/site-parameters';

/**
 * The configuration contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CF-063 — WHAT IS NOT HERE, AND WILL NOT BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no `allowOverlap`, no `historyImmutable`, no `closedByDefault` and
 * no `blocksCalendar` in this file, and there is a test that fails if one
 * appears. Those are not parameters the clinic forgot to expose: they are the
 * guarantees the system is built on, and each of them stops being a guarantee
 * the moment it can be switched off from a screen.
 *
 *   - Non-overlap is an `EXCLUDE USING gist` in the base (REQ-140). A flag
 *     that turned it off would mean two patients in the same chair, and the
 *     documented way to break it deliberately already exists: the overbooking,
 *     which is recorded per appointment (REQ-143, AG-035).
 *   - Immutability of the status history is an append-only trigger (REQ-142).
 *     Configuring it away would remove the answer to «¿por qué salió anulada?»
 *     retroactively.
 *   - Closed-by-default authorisation is what makes a forgotten annotation a
 *     refusal instead of an open door (REQ-118, REQ-146).
 *
 * What IS configurable is the four numbers of D-001 below plus the past
 * booking switch of AG-094, and the reason they are safe to configure is that
 * no guarantee depends on their value — only behaviour does. Admitting a start
 * earlier than now changes WHICH HOUR is accepted; the `EXCLUDE` still refuses
 * an overlap in that hour, the status history is still append-only, and the
 * booking route still demands its permission and its site scope.
 *
 * THE TWO OF THE OVERBOOKING (E4, AG-039, AG-101) PASS THE SAME TEST, and the
 * second one is worth stating because it looks like it does not: configuring
 * WHICH PERMISSION authorises an exception is not configuring the exception
 * away. The `EXCLUDE` still stands — the overbooking is exempt from it by the
 * same `blocks_calendar` predicate it always was — the constancia is a CHECK
 * of the base, and the separation between whoever books and whoever authorises
 * (AG-103) is not a parameter and never will be. What the clinic chooses is
 * WHO carries the decision, which is exactly the kind of thing D-002 says is
 * the clinic's policy and not the code's.
 */

// --- Holidays (CF-060, CF-061) ---------------------------------------------

/**
 * A calendar day, `YYYY-MM-DD`, kept as a STRING end to end.
 *
 * Not `z.coerce.date()`. A holiday is a day of the civil calendar, and turning
 * «2026-01-01» into a `Date` pins it to midnight UTC — which in
 * `America/Guayaquil` is the 31st of December at 19:00. The day would then
 * shift depending on who read it back, which is exactly the class of defect
 * the constitution's timezone rule exists for.
 */
const holidayDateSchema = z
  .string({ error: 'Indique la fecha del feriado' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Indique la fecha como AAAA-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'Esa fecha no existe en el calendario',
  });

const holidayNameSchema = z
  .string({ error: 'Indique el nombre del feriado' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(160, 'El nombre no puede superar 160 caracteres');

/**
 * The SCOPE of CF-060. `null` — or absent — means every site.
 *
 * Nullable rather than a separate `appliesToAllSites` boolean: two fields that
 * can disagree is a state the base would have to arbitrate, and «todas las
 * sedes» is not a different kind of holiday, it is the same holiday with a
 * wider radius.
 */
const holidaySiteSchema = z
  .uuid('Seleccione una sede de la lista o deje el feriado para todas')
  .nullish();

export const listHolidaysQuerySchema = z.object({
  /**
   * A year and not a free date range: that is what the screen asks for and
   * what the agenda will ask for, and an unbounded range over a table the
   * clinic edits by hand is a listing nobody can paginate.
   */
  year: z.coerce
    .number({ error: 'Indique el año' })
    .int('El año es un número entero')
    .min(2000, 'El año debe estar entre 2000 y 2100')
    .max(2100, 'El año debe estar entre 2000 y 2100'),
  /**
   * When present, the answer carries the holidays of THAT site plus the ones
   * that apply to every site — which is what the site actually observes.
   */
  siteId: z.uuid('Seleccione una sede de la lista').optional(),
});
/** Query of GET /configuration/holidays. */
export class ListHolidaysQueryDto extends createZodDto(
  listHolidaysQuerySchema,
) {}

export const createHolidaySchema = z.object({
  date: holidayDateSchema,
  name: holidayNameSchema,
  siteId: holidaySiteSchema,
});
/** Body of POST /configuration/holidays. */
export class CreateHolidayDto extends createZodDto(createHolidaySchema) {}

export const updateHolidaySchema = z
  .object({
    date: holidayDateSchema.optional(),
    name: holidayNameSchema.optional(),
    siteId: holidaySiteSchema,
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un cambio',
  });
/** Body of PATCH /configuration/holidays/:id; an empty body is refused. */
export class UpdateHolidayDto extends createZodDto(updateHolidaySchema) {}

export const holidaySchema = z.object({
  id: z.uuid(),
  date: z.string(),
  name: z.string(),
  /** `null` = todas las sedes (CF-060). */
  siteId: z.uuid().nullable(),
  /**
   * AG-092. Las sedes que TRABAJAN ese feriado; vacío es lo normal.
   *
   * Viaja en el listado porque, si no, nada en la pantalla delata que un
   * feriado nacional tiene una excepción, y la única forma de enterarse sería
   * pedir la disponibilidad de cada sede día a día.
   */
  workedBySiteIds: z.array(z.uuid()).readonly(),
});
/** Response of creating and updating a holiday, and of marking or unmarking a site that works it. */
export class HolidayDto extends createZodDto(holidaySchema) {}

export const holidayListSchema = z.object({
  items: z.array(holidaySchema).readonly(),
});
/** Response of GET /configuration/holidays. */
export class HolidayListDto extends createZodDto(holidayListSchema) {}

// --- Site parameters (CF-062, CF-065) --------------------------------------

/**
 * THE RANGES ARE NOT HERE, and that is deliberate.
 *
 * The DTO refuses what is not an integer — the shape of the transport. The
 * RANGE is a rule of the clinic: CF-065 requires the answer to be
 * `PARAM_OUT_OF_RANGE` naming the range, and a Zod failure answers with the
 * generic validation problem instead. So `assertParametersInRange` in the
 * domain owns it, the CHECK constraints own it a third time for whatever
 * bypasses both, and this schema stops at «es un entero».
 */
const parameterSchema = z
  .number({ error: 'Indique un número entero' })
  .int('Indique un número entero');

export const updateSiteParametersSchema = z
  .object({
    minLeadMinutes: parameterSchema.optional(),
    maxLeadDays: parameterSchema.optional(),
    overbookingCap: parameterSchema.optional(),
    /**
     * D-021. The atom of the agenda. Its range and its step of 5 are not here
     * for the same reason the other three ranges are not: CF-065 has to answer
     * `PARAM_OUT_OF_RANGE` naming the range, and a Zod failure answers with
     * the generic validation problem.
     */
    slotAtomMinutes: parameterSchema.optional(),
    /**
     * AG-031, AG-094. Whether the site admits a start earlier than now.
     *
     * NO RANGE, because a boolean has none: `assertParametersInRange` walks
     * `PARAMETER_RANGES` and this key is deliberately not in it. Both values
     * are legitimate; which one the site wants is the whole decision.
     */
    allowPastBooking: z
      .boolean({ error: 'Indique si la sede admite reservar en el pasado' })
      .optional(),
    /**
     * AG-039, AG-094. Whether this site admits overbookings.
     *
     * A boolean, so it has no range either — and its default is the opposite
     * of the one above (D-005): the overbooking is the DOCUMENTED way of
     * breaking the grid, and what keeps it from becoming the normal route is
     * the cap, which is a number this same form administers.
     */
    overbookingEnabled: z
      .boolean({ error: 'Indique si la sede admite sobrecupos' })
      .optional(),
    /**
     * AG-101, AG-094. Which permission authorises an overbooking here.
     *
     * A STRING AND NOT A `z.enum` OF THE CATALOGUE, deliberately. Declaring
     * the union here would answer an unknown code with the generic validation
     * problem, and AU-033 already fixed the two answers this question
     * deserves: `UNKNOWN_PERMISSION` for a code the CODE does not declare, and
     * `PERMISSION_NOT_INSTALLED` for one this installation has not seeded. The
     * domain and the service own them; this schema stops at «es un texto».
     */
    overbookingPermission: z
      .string({ error: 'Indique el permiso que autoriza los sobrecupos' })
      .trim()
      .min(1, 'Indique el permiso que autoriza los sobrecupos')
      .max(64, 'Un código de permiso no supera 64 caracteres')
      .optional(),
    /**
     * AG-066, AG-094. Cuántas llamadas agotan una entrada de lista de espera.
     *
     * Sin rango aquí, por lo mismo que los otros números: CF-065 tiene que
     * responder `PARAM_OUT_OF_RANGE` nombrando el rango, y un fallo de Zod
     * responde con el problema genérico de validación.
     */
    waitlistMaxContactAttempts: parameterSchema.optional(),
    /**
     * One value today (D-001, D-004): the system does not delete. It travels
     * in the contract anyway so the screen can show what the policy IS, and so
     * the day a purge policy is added the field already exists.
     */
    cancelledRetention: z.enum(CANCELLED_RETENTION_POLICIES).optional(),
    /**
     * ORD-063, ORD-065. `null` says «sin plazo» and is a value; absent says
     * «no lo toque». Ranges are judged by the domain, which names them.
     */
    criticalNoticeWithinMinutes: parameterSchema.nullable().optional(),
    criticalEscalationRoleId: z
      .uuid('Elija el rol al que se escala')
      .nullable()
      .optional(),
    /** ORD-046, D-050 §4. `null` = quien pidió el examen. */
    unmatchedResultOwnerRoleId: z
      .uuid('Elija el rol responsable')
      .nullable()
      .optional(),
    unmatchedResultDeadlineHours: parameterSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un parámetro que cambiar',
  });
/** Body of PUT /configuration/sites/:siteId/parameters: a partial set, of which at least one must be present. */
export class UpdateSiteParametersDto extends createZodDto(
  updateSiteParametersSchema,
) {}

export const siteParametersSchema = z.object({
  siteId: z.uuid(),
  minLeadMinutes: z.number().int(),
  maxLeadDays: z.number().int(),
  overbookingCap: z.number().int(),
  /** D-021. The site's slot atom, which every duration is a multiple of. */
  slotAtomMinutes: z.number().int(),
  /** AG-031, AG-094. It travels in the ANSWER too, or nobody can see it. */
  allowPastBooking: z.boolean(),
  /** AG-039, AG-094. Same reason: a parameter nobody can see is not one. */
  overbookingEnabled: z.boolean(),
  /** AG-101, AG-094. The code, as stored — the screen shows what it means. */
  overbookingPermission: z.string(),
  /** AG-066, AG-094. Viaja en la respuesta o la sede no puede verlo (D-040). */
  waitlistMaxContactAttempts: z.number().int(),
  cancelledRetention: z.enum(CANCELLED_RETENTION_POLICIES),
  /** ORD-063, ORD-065. `null` = la clínica no ha fijado plazo (D-111). */
  criticalNoticeWithinMinutes: z.number().int().nullable(),
  criticalEscalationRoleId: z.uuid().nullable(),
  /** ORD-046, D-050 §4. `null` = quien pidió el examen. */
  unmatchedResultOwnerRoleId: z.uuid().nullable(),
  unmatchedResultDeadlineHours: z.number().int(),
});
/** Response of reading and saving a site's parameters: always the whole set. */
export class SiteParametersDto extends createZodDto(siteParametersSchema) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type HolidayResponse = z.infer<typeof holidaySchema>;
export type HolidayListResponse = z.infer<typeof holidayListSchema>;
export type SiteParametersResponse = z.infer<typeof siteParametersSchema>;
