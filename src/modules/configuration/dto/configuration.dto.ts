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
 * What IS configurable is the four numbers of D-001 below, and the reason they
 * are safe to configure is that no guarantee depends on their value — only
 * behaviour does.
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
export class ListHolidaysQueryDto extends createZodDto(
  listHolidaysQuerySchema,
) {}

export const createHolidaySchema = z.object({
  date: holidayDateSchema,
  name: holidayNameSchema,
  siteId: holidaySiteSchema,
});
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
export class UpdateHolidayDto extends createZodDto(updateHolidaySchema) {}

export const holidaySchema = z.object({
  id: z.uuid(),
  date: z.string(),
  name: z.string(),
  /** `null` = todas las sedes (CF-060). */
  siteId: z.uuid().nullable(),
});
export class HolidayDto extends createZodDto(holidaySchema) {}

export const holidayListSchema = z.object({
  items: z.array(holidaySchema).readonly(),
});
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
     * One value today (D-001, D-004): the system does not delete. It travels
     * in the contract anyway so the screen can show what the policy IS, and so
     * the day a purge policy is added the field already exists.
     */
    cancelledRetention: z.enum(CANCELLED_RETENTION_POLICIES).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un parámetro que cambiar',
  });
export class UpdateSiteParametersDto extends createZodDto(
  updateSiteParametersSchema,
) {}

export const siteParametersSchema = z.object({
  siteId: z.uuid(),
  minLeadMinutes: z.number().int(),
  maxLeadDays: z.number().int(),
  overbookingCap: z.number().int(),
  cancelledRetention: z.enum(CANCELLED_RETENTION_POLICIES),
});
export class SiteParametersDto extends createZodDto(siteParametersSchema) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type HolidayResponse = z.infer<typeof holidaySchema>;
export type HolidayListResponse = z.infer<typeof holidayListSchema>;
export type SiteParametersResponse = z.infer<typeof siteParametersSchema>;
