import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// SP-007: las desactivadas viajan solo si se piden EXPLÍCITAMENTE.
import { explicitFlag } from '../../../shared/http/query-flag';
import { specialtyCodeFromName } from '../domain/specialty-code';

/**
 * The specialties contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 */

const specialtyNameSchema = z
  .string({ error: 'Indique el nombre de la especialidad' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(160, 'El nombre no puede superar 160 caracteres');

/**
 * SP-009: AT CREATION the name is also the source of the stable code (D-011),
 * so it has to have something derivable in it. A name written entirely in
 * characters the code alphabet cannot represent would derive to '', and the
 * functional unique index would then hand the first such specialty the empty
 * code and refuse every later one with a conflict nobody could act on.
 *
 * NOT REQUIRED ON RENAME, and that is not an oversight: the code is derived
 * once and never again (SP-010), so after creation the name has stopped being
 * anybody's identifier.
 */
const derivableSpecialtyNameSchema = specialtyNameSchema.refine(
  (name) => specialtyCodeFromName(name) !== '',
  { message: 'El nombre debe incluir letras o números' },
);

// --- Specialties (SP-001..SP-008) -----------------------------------------

export const listSpecialtiesQuerySchema = z.object({
  /** SP-007: deactivated rows only on explicit request. */
  includeInactive: explicitFlag,
});
/** Query of GET /specialties. */
export class ListSpecialtiesQueryDto extends createZodDto(
  listSpecialtiesQuerySchema,
) {}

/**
 * SP-009: the CODE IS NOT IN THE REQUEST. It is derived from the name by
 * `specialtyCodeFromName` and returned in the response, because ADR-005 §5
 * refuses to ask anybody to type an identifier they cannot interpret. It is
 * still a public contract — it just stopped being something a form asks for.
 */
export const createSpecialtySchema = z.object({
  name: derivableSpecialtyNameSchema,
});
/** Body of POST /specialties (`config:manage`). */
export class CreateSpecialtyDto extends createZodDto(createSpecialtySchema) {}

/**
 * Rename or (de)activate — the CODE is not editable AND IS NOT RE-DERIVED
 * either: it is the stable contract of D-011, and a PATCH that could change it
 * would break every report, every `practitioner_specialty` row and the MSP
 * seed, all of which hold on to it. Fixing a missing accent in «Ginecologia»
 * must not move the identity of the row. See
 * `SpecialtiesService.updateSpecialty`.
 */
export const updateSpecialtySchema = z
  .object({
    name: specialtyNameSchema.optional(),
    active: z.boolean({ error: 'Indique si la especialidad está activa' }).optional(), // prettier-ignore
  })
  .refine((value) => value.name !== undefined || value.active !== undefined, {
    message: 'Indique al menos un cambio: nombre o estado',
  });
/** Body of PATCH /specialties/:id. */
export class UpdateSpecialtyDto extends createZodDto(updateSpecialtySchema) {}

export const specialtySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
/** Response of creating and updating a specialty; `code` is where the derived code comes back. */
export class SpecialtyDto extends createZodDto(specialtySchema) {}

export const specialtyListSchema = z.object({
  items: z.array(specialtySchema).readonly(),
});
/** Response of GET /specialties. */
export class SpecialtyListDto extends createZodDto(specialtyListSchema) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type SpecialtyResponse = z.infer<typeof specialtySchema>;
export type SpecialtyListResponse = z.infer<typeof specialtyListSchema>;
