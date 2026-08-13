import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The specialties contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 */

/**
 * A flag that only the literal `true` turns on. Same reasoning as the
 * agenda's `includeReleased`: `z.coerce.boolean()` follows JavaScript
 * truthiness, so `?includeInactive=false` would become `true` — and SP-007
 * says deactivated rows travel only when asked for EXPLICITLY.
 */
const explicitFlag = z
  .enum(['true', 'false'], { error: 'Indique verdadero o falso' })
  .default('false')
  .transform((value) => value === 'true');

/**
 * SP-021 mirrored from the CHECK `service_type_duration_range`: 5..240 in
 * multiples of 5. The base has the final word; this is the version that
 * answers per-field instead of via a constraint translation.
 */
const durationMinutesSchema = z
  .number({ error: 'Indique la duración en minutos' })
  .int('La duración debe ser un número entero de minutos')
  .min(5, 'La duración mínima es de 5 minutos')
  .max(240, 'La duración máxima es de 240 minutos')
  .multipleOf(5, 'La duración debe ser un múltiplo de 5 minutos');

/**
 * D-011: a stable code — letters, digits and hyphens, no spaces or accents.
 * It is the contract billing and reports hold on to, which is why renaming a
 * specialty changes `name` and never `code`.
 */
const specialtyCodeSchema = z
  .string({ error: 'Indique el código de la especialidad' })
  .trim()
  .min(2, 'El código debe tener al menos 2 caracteres')
  .max(64, 'El código no puede superar 64 caracteres')
  .regex(
    /^[a-z0-9-]+$/i,
    'El código solo admite letras, números y guiones, sin espacios ni acentos',
  );

const specialtyNameSchema = z
  .string({ error: 'Indique el nombre de la especialidad' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(160, 'El nombre no puede superar 160 caracteres');

const serviceTypeNameSchema = z
  .string({ error: 'Indique el nombre del tipo de atención' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(120, 'El nombre no puede superar 120 caracteres');

// --- Specialties (SP-001..SP-008) -----------------------------------------

export const listSpecialtiesQuerySchema = z.object({
  /** SP-007: deactivated rows only on explicit request. */
  includeInactive: explicitFlag,
});
export class ListSpecialtiesQueryDto extends createZodDto(
  listSpecialtiesQuerySchema,
) {}

export const createSpecialtySchema = z.object({
  code: specialtyCodeSchema,
  name: specialtyNameSchema,
});
export class CreateSpecialtyDto extends createZodDto(createSpecialtySchema) {}

/**
 * Rename or (de)activate — the CODE is not editable: it is the stable
 * contract of D-011, and a PATCH that could change it would break every
 * report that stored it.
 */
export const updateSpecialtySchema = z
  .object({
    name: specialtyNameSchema.optional(),
    active: z.boolean({ error: 'Indique si la especialidad está activa' }).optional(), // prettier-ignore
  })
  .refine((value) => value.name !== undefined || value.active !== undefined, {
    message: 'Indique al menos un cambio: nombre o estado',
  });
export class UpdateSpecialtyDto extends createZodDto(updateSpecialtySchema) {}

export const specialtySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export class SpecialtyDto extends createZodDto(specialtySchema) {}

export const specialtyListSchema = z.object({
  items: z.array(specialtySchema).readonly(),
});
export class SpecialtyListDto extends createZodDto(specialtyListSchema) {}

// --- Service types (SP-020..SP-027) ----------------------------------------

export const listServiceTypesQuerySchema = z.object({
  includeInactive: explicitFlag,
});
export class ListServiceTypesQueryDto extends createZodDto(
  listServiceTypesQuerySchema,
) {}

export const createServiceTypeSchema = z.object({
  name: serviceTypeNameSchema,
  durationMinutes: durationMinutesSchema,
});
export class CreateServiceTypeDto extends createZodDto(
  createServiceTypeSchema,
) {}

export const updateServiceTypeSchema = z
  .object({
    name: serviceTypeNameSchema.optional(),
    durationMinutes: durationMinutesSchema.optional(),
    active: z.boolean({ error: 'Indique si el tipo está activo' }).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.durationMinutes !== undefined ||
      value.active !== undefined,
    { message: 'Indique al menos un cambio: nombre, duración o estado' },
  );
export class UpdateServiceTypeDto extends createZodDto(
  updateServiceTypeSchema,
) {}

export const serviceTypeSchema = z.object({
  id: z.uuid(),
  specialtyId: z.uuid(),
  name: z.string(),
  durationMinutes: z.number().int(),
  active: z.boolean(),
});
export class ServiceTypeDto extends createZodDto(serviceTypeSchema) {}

export const serviceTypeListSchema = z.object({
  items: z.array(serviceTypeSchema).readonly(),
});
export class ServiceTypeListDto extends createZodDto(serviceTypeListSchema) {}

// --- Practitioner specialties (SP-005, SP-008) ------------------------------

export const assignSpecialtiesSchema = z.object({
  items: z
    .array(
      z.object({
        specialtyId: z.uuid('Seleccione una especialidad de la lista'),
        isPrimary: z.boolean({ error: 'Indique si es la principal' }),
      }),
      { error: 'Indique las especialidades del profesional' },
    )
    .min(1, 'Asigne al menos una especialidad')
    /**
     * Duplicates refused HERE, not in the service: two rows for the same
     * specialty are a malformed request, not a business decision, and the
     * composite primary key would answer with a constraint violation the
     * form cannot point at a field.
     */
    .refine(
      (items) =>
        new Set(items.map((item) => item.specialtyId)).size === items.length,
      { message: 'Hay una especialidad repetida en la asignación' },
    ),
});
export class AssignSpecialtiesDto extends createZodDto(
  assignSpecialtiesSchema,
) {}

export const practitionerSpecialtySchema = z.object({
  specialtyId: z.uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  /** SP-005, SP-008: exactly one row carries `true`. */
  isPrimary: z.boolean(),
});
export class PractitionerSpecialtyDto extends createZodDto(
  practitionerSpecialtySchema,
) {}

export const practitionerSpecialtyListSchema = z.object({
  items: z.array(practitionerSpecialtySchema).readonly(),
});
export class PractitionerSpecialtyListDto extends createZodDto(
  practitionerSpecialtyListSchema,
) {}

// --- Duration exceptions (SP-022, SP-023, SP-028) ---------------------------

export const setDurationExceptionSchema = z.object({
  durationMinutes: durationMinutesSchema,
});
export class SetDurationExceptionDto extends createZodDto(
  setDurationExceptionSchema,
) {}

export const practitionerDurationSchema = z.object({
  serviceTypeId: z.uuid(),
  serviceTypeName: z.string(),
  specialtyId: z.uuid(),
  specialtyName: z.string(),
  /** The base duration of the specialty·type (SP-020). */
  baseMinutes: z.number().int(),
  /** The practitioner's own exception, or `null` when none is set (SP-022). */
  exceptionMinutes: z.number().int().nullable(),
  /**
   * SP-023 already applied — exception over base — through the same domain
   * function the agenda will use for SP-028. Serving it resolved is what
   * keeps the screen and the booking from computing it twice differently.
   */
  resolvedMinutes: z.number().int(),
});
export class PractitionerDurationDto extends createZodDto(
  practitionerDurationSchema,
) {}

export const practitionerDurationListSchema = z.object({
  items: z.array(practitionerDurationSchema).readonly(),
});
export class PractitionerDurationListDto extends createZodDto(
  practitionerDurationListSchema,
) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type SpecialtyResponse = z.infer<typeof specialtySchema>;
export type SpecialtyListResponse = z.infer<typeof specialtyListSchema>;
export type ServiceTypeResponse = z.infer<typeof serviceTypeSchema>;
export type ServiceTypeListResponse = z.infer<typeof serviceTypeListSchema>;
export type PractitionerSpecialtyListResponse = z.infer<
  typeof practitionerSpecialtyListSchema
>;
export type PractitionerDurationListResponse = z.infer<
  typeof practitionerDurationListSchema
>;
