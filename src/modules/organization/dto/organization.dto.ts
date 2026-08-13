import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The organization contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 */

/**
 * A flag that only the literal `true` turns on. Same reasoning as the
 * specialties listing: `z.coerce.boolean()` follows JavaScript truthiness, so
 * `?includeInactive=false` would become `true` — and OR-007 says deactivated
 * rows travel only when asked for EXPLICITLY.
 */
const explicitFlag = z
  .enum(['true', 'false'], { error: 'Indique verdadero o falso' })
  .default('false')
  .transform((value) => value === 'true');

export const listQuerySchema = z.object({
  includeInactive: explicitFlag,
});
export class ListQueryDto extends createZodDto(listQuerySchema) {}

/**
 * OR-008. The DTO caps the LENGTH and nothing else: the thirteen digits, the
 * province, the three check-digit algorithms and the establishment code are
 * the `Ruc` value object's, and splitting the rule in two would let the two
 * halves disagree. Everything the value object refuses answers `INVALID_RUC`
 * with a field error, which is the code the SPEC fixes.
 *
 * An empty string is how a browser form sends a cleared field; the service
 * reads it as «no RUC» and stores NULL.
 */
const rucSchema = z
  .string({ error: 'Indique el RUC' })
  .trim()
  .max(20, 'El RUC son trece dígitos');

const mspUnicodeSchema = z
  .string({ error: 'Indique el código único del MSP' })
  .trim()
  .min(1, 'Indique el código único del MSP')
  .max(20, 'El código único del MSP no puede superar 20 caracteres');

// --- Establishment (OR-001..OR-003, OR-008) --------------------------------

/**
 * OR-001: the typology and the MSP code are REQUIRED, both of them. The
 * requirement says the system must not operate without them, and the cheapest
 * place to keep that true is the only door through which they are written.
 */
export const saveEstablishmentSchema = z.object({
  mspUnicode: mspUnicodeSchema,
  typology: z
    .string({ error: 'Indique la tipología del establecimiento' })
    .trim()
    .min(2, 'La tipología debe tener al menos 2 caracteres')
    .max(64, 'La tipología no puede superar 64 caracteres'),
  legalName: z
    .string({ error: 'Indique la razón social del establecimiento' })
    .trim()
    .min(2, 'La razón social debe tener al menos 2 caracteres')
    .max(160, 'La razón social no puede superar 160 caracteres'),
  ruc: rucSchema.nullish(),
  active: z.boolean({ error: 'Indique si el establecimiento está activo' }).optional(), // prettier-ignore
});
export class SaveEstablishmentDto extends createZodDto(
  saveEstablishmentSchema,
) {}

export const establishmentSchema = z.object({
  id: z.uuid(),
  /** OR-003: the code every attention must carry (REQ-020). */
  mspUnicode: z.string(),
  typology: z.string(),
  legalName: z.string(),
  /** OR-025: exposed to billing as data, with no sequential attached. */
  ruc: z.string().nullable(),
  active: z.boolean(),
});
export class EstablishmentDto extends createZodDto(establishmentSchema) {}

// --- Sites (OR-004..OR-008) ------------------------------------------------

const siteNameSchema = z
  .string({ error: 'Indique el nombre de la sede' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(160, 'El nombre no puede superar 160 caracteres');

const addressLineSchema = z
  .string()
  .trim()
  .max(255, 'La dirección no puede superar 255 caracteres');

const phoneSchema = z
  .string()
  .trim()
  .max(32, 'El teléfono no puede superar 32 caracteres');

export const createSiteSchema = z.object({
  mspUnicode: mspUnicodeSchema,
  name: siteNameSchema,
  ruc: rucSchema.nullish(),
  /** OR-004: parish of the INEC's DPA, a concept of `catalogs`. */
  parishConceptId: z.uuid('Seleccione una parroquia de la lista').nullish(),
  addressLine: addressLineSchema.nullish(),
  phone: phoneSchema.nullish(),
});
export class CreateSiteDto extends createZodDto(createSiteSchema) {}

/**
 * The MSP code is absent on purpose: it identifies the site in every attention
 * already reported to the ministry (REQ-020), so a PATCH that could change it
 * would rewrite the meaning of reports already filed.
 */
export const updateSiteSchema = z
  .object({
    name: siteNameSchema.optional(),
    ruc: rucSchema.nullish(),
    parishConceptId: z.uuid('Seleccione una parroquia de la lista').nullish(),
    addressLine: addressLineSchema.nullish(),
    phone: phoneSchema.nullish(),
    active: z.boolean({ error: 'Indique si la sede está activa' }).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un cambio',
  });
export class UpdateSiteDto extends createZodDto(updateSiteSchema) {}

export const siteSchema = z.object({
  id: z.uuid(),
  establishmentId: z.uuid().nullable(),
  mspUnicode: z.string(),
  name: z.string(),
  ruc: z.string().nullable(),
  parishConceptId: z.uuid().nullable(),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
  /** OR-007: `false` means it is not offered for new appointments. */
  active: z.boolean(),
});
export class SiteDto extends createZodDto(siteSchema) {}

export const siteListSchema = z.object({
  items: z.array(siteSchema).readonly(),
});
export class SiteListDto extends createZodDto(siteListSchema) {}

// --- Consulting rooms (OR-020..OR-022) -------------------------------------

const roomNameSchema = z
  .string({ error: 'Indique el nombre del consultorio' })
  .trim()
  .min(1, 'Indique el nombre del consultorio')
  .max(80, 'El nombre no puede superar 80 caracteres');

export const createRoomSchema = z.object({ name: roomNameSchema });
export class CreateRoomDto extends createZodDto(createRoomSchema) {}

export const updateRoomSchema = z
  .object({
    name: roomNameSchema.optional(),
    active: z.boolean({ error: 'Indique si el consultorio está activo' }).optional(), // prettier-ignore
  })
  .refine((value) => value.name !== undefined || value.active !== undefined, {
    message: 'Indique al menos un cambio: nombre o estado',
  });
export class UpdateRoomDto extends createZodDto(updateRoomSchema) {}

export const roomSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  name: z.string(),
  active: z.boolean(),
});
export class RoomDto extends createZodDto(roomSchema) {}

export const roomListSchema = z.object({
  items: z.array(roomSchema).readonly(),
});
export class RoomListDto extends createZodDto(roomListSchema) {}

// --- Points of emission (OR-023..OR-025) -----------------------------------

/**
 * OR-023, mirrored from the CHECK `emission_point_code_format`. A string and
 * not a number: the leading zero is significant — «001» is the first point of
 * emission and `1` is not a point of emission at all.
 */
const emissionPointCodeSchema = z
  .string({ error: 'Indique el código del punto de emisión' })
  .trim()
  .regex(/^\d{3}$/, 'El punto de emisión son exactamente tres dígitos, como 001'); // prettier-ignore

const emissionPointDescriptionSchema = z
  .string()
  .trim()
  .max(120, 'La descripción no puede superar 120 caracteres');

export const createEmissionPointSchema = z.object({
  code: emissionPointCodeSchema,
  description: emissionPointDescriptionSchema.nullish(),
});
export class CreateEmissionPointDto extends createZodDto(
  createEmissionPointSchema,
) {}

/**
 * The CODE is not editable: `billing` stores it on every comprobante it issues
 * (REQ-085), so changing it would rewrite documents already filed with the
 * SRI. Deactivating the point is what an administrator actually needs.
 */
export const updateEmissionPointSchema = z
  .object({
    description: emissionPointDescriptionSchema.nullish(),
    active: z.boolean({ error: 'Indique si el punto de emisión está activo' }).optional(), // prettier-ignore
  })
  .refine(
    (value) => value.description !== undefined || value.active !== undefined,
    { message: 'Indique al menos un cambio: descripción o estado' },
  );
export class UpdateEmissionPointDto extends createZodDto(
  updateEmissionPointSchema,
) {}

export const emissionPointSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  code: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export class EmissionPointDto extends createZodDto(emissionPointSchema) {}

export const emissionPointListSchema = z.object({
  items: z.array(emissionPointSchema).readonly(),
});
export class EmissionPointListDto extends createZodDto(
  emissionPointListSchema,
) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type EstablishmentResponse = z.infer<typeof establishmentSchema>;
export type SiteResponse = z.infer<typeof siteSchema>;
export type SiteListResponse = z.infer<typeof siteListSchema>;
export type RoomResponse = z.infer<typeof roomSchema>;
export type RoomListResponse = z.infer<typeof roomListSchema>;
export type EmissionPointResponse = z.infer<typeof emissionPointSchema>;
export type EmissionPointListResponse = z.infer<typeof emissionPointListSchema>;
