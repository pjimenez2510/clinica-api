import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// OR-007: las desactivadas viajan solo si se piden EXPLÍCITAMENTE.
import { explicitFlag } from '../../../shared/http/query-flag';

/**
 * The organization contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 */

export const listQuerySchema = z.object({
  includeInactive: explicitFlag,
});
/** Query of every organization listing: sites, rooms and points of emission. */
export class ListQueryDto extends createZodDto(listQuerySchema) {}

/**
 * OR-008. The DTO caps the LENGTH and nothing else: the thirteen digits, the
 * province, the kind, the natural person's check digit and the establishment
 * code are the `Ruc` value object's (OR-008, OR-009), and splitting the rule in two would let the two
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
/** Body of PUT /organization/establishment: there is one establishment, so it is saved whole rather than created. */
export class SaveEstablishmentDto extends createZodDto(
  saveEstablishmentSchema,
) {}

export const establishmentSchema = z.object({
  id: z.uuid(),
  /** OR-003: the code every attention must carry (REQ-020). */
  mspUnicode: z.string(),
  typology: z.string(),
  legalName: z.string(),
  /**
   * OR-025: exposed to billing as data, with no sequential attached — and ONLY
   * to billing. See the block above `siteSchema` («WHY THE RUC IS OPTIONAL IN
   * BOTH RESPONSES») for why the field can be absent.
   */
  ruc: z.string().nullable().optional(),
  /** OR-010 to OR-012: what the documents' header prints. */
  tradeName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  operatingPermit: z.string().nullable(),
  active: z.boolean(),
});
/** Response of reading and saving the establishment. */
export class EstablishmentDto extends createZodDto(establishmentSchema) {}

/**
 * OR-010 to OR-012. The three are sent every time — `null` clears one — so the
 * request says the whole state of what the documents' header prints.
 */
export const saveDocumentIdentitySchema = z.object({
  tradeName: z
    .string()
    .trim()
    .max(160, 'El nombre comercial no puede superar 160 caracteres')
    .nullable(),
  contactEmail: z
    .union([
      z.literal(''),
      z
        .email('Ingrese un correo electrónico válido')
        .max(254, 'El correo no puede superar 254 caracteres'),
    ])
    .nullable(),
  operatingPermit: z
    .string()
    .trim()
    .max(40, 'El permiso de funcionamiento no puede superar 40 caracteres')
    .nullable(),
});
/** Body of PUT /organization/establishment/document-identity. */
export class SaveDocumentIdentityDto extends createZodDto(
  saveDocumentIdentitySchema,
) {}

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
/** Body of POST /organization/sites. */
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
/** Body of PATCH /organization/sites/:id; an empty body is refused. */
export class UpdateSiteDto extends createZodDto(updateSiteSchema) {}

/**
 * WHY THE RUC IS OPTIONAL IN BOTH RESPONSES, AND WHAT ITS ABSENCE MEANS.
 *
 * A natural-person RUC's first ten digits ARE the owner's cedula, check digit
 * included — `ruc.vo.ts` says so where it explains why `InvalidRucError`
 * withholds the value it rejected. In a clinic registered under the doctor's
 * own RUC, serving it under `site:read` hands their national ID to reception,
 * to nursing and to every clinical role, none of which needs it: the RUC is
 * for billing (OR-025), and booking an appointment is not billing.
 *
 * So it travels only to `site:manage`, and it is OMITTED rather than nulled.
 * `null` already means «esta sede no tiene RUC» — a real state a screen acts
 * on — and reusing it for «no le corresponde verlo» would make the two
 * indistinguishable. Absent is the honest third answer.
 */
export const siteSchema = z.object({
  id: z.uuid(),
  establishmentId: z.uuid().nullable(),
  mspUnicode: z.string(),
  name: z.string(),
  /** Present only for a caller holding `site:manage`. See above. */
  ruc: z.string().nullable().optional(),
  parishConceptId: z.uuid().nullable(),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
  /** OR-007: `false` means it is not offered for new appointments. */
  active: z.boolean(),
});
/** Response of reading, creating and updating one site. */
export class SiteDto extends createZodDto(siteSchema) {}

export const siteListSchema = z.object({
  items: z.array(siteSchema).readonly(),
});
/** Response of GET /organization/sites. */
export class SiteListDto extends createZodDto(siteListSchema) {}

// --- Consulting rooms (OR-020..OR-022) -------------------------------------

const roomNameSchema = z
  .string({ error: 'Indique el nombre del consultorio' })
  .trim()
  .min(1, 'Indique el nombre del consultorio')
  .max(80, 'El nombre no puede superar 80 caracteres');

export const createRoomSchema = z.object({ name: roomNameSchema });
/** Body of POST /organization/sites/:siteId/rooms; the site is the route's. */
export class CreateRoomDto extends createZodDto(createRoomSchema) {}

export const updateRoomSchema = z
  .object({
    name: roomNameSchema.optional(),
    active: z.boolean({ error: 'Indique si el consultorio está activo' }).optional(), // prettier-ignore
  })
  .refine((value) => value.name !== undefined || value.active !== undefined, {
    message: 'Indique al menos un cambio: nombre o estado',
  });
/** Body of PATCH /organization/rooms/:id. */
export class UpdateRoomDto extends createZodDto(updateRoomSchema) {}

export const roomSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  name: z.string(),
  active: z.boolean(),
});
/** Response of creating and updating a consulting room. */
export class RoomDto extends createZodDto(roomSchema) {}

export const roomListSchema = z.object({
  items: z.array(roomSchema).readonly(),
});
/** Response of GET /organization/sites/:siteId/rooms. */
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
/** Body of POST /organization/sites/:siteId/emission-points; the site is the route's. */
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
/** Body of PATCH /organization/emission-points/:id. */
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
/** Response of creating and updating a point of emission. */
export class EmissionPointDto extends createZodDto(emissionPointSchema) {}

export const emissionPointListSchema = z.object({
  items: z.array(emissionPointSchema).readonly(),
});
/** Response of GET /organization/sites/:siteId/emission-points. */
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
