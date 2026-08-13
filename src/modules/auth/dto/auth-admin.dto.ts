import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';

/**
 * The administration contract, requests and responses (A2).
 *
 * Kept apart from `auth.dto.ts`, which is the session half: the two share the
 * `app_user` table and nothing else, and a single file would make it hard to
 * see that nothing in the administration screens can reach a password field.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005.
 */

/**
 * A flag that only the literal `true` turns on. `z.coerce.boolean()` follows
 * JavaScript truthiness, so `?includeInactive=false` would become `true` — and
 * AU-022 says deactivated accounts travel only when asked for EXPLICITLY.
 */
const explicitFlag = z
  .enum(['true', 'false'], { error: 'Indique verdadero o falso' })
  .default('false')
  .transform((value) => value === 'true');

// --- Accounts (AU-020..AU-025) ---------------------------------------------

const nameSchema = (what: string) =>
  z
    .string({ error: `Indique el ${what}` })
    .trim()
    .min(2, `El ${what} debe tener al menos 2 caracteres`)
    .max(120, `El ${what} no puede superar 120 caracteres`);

/**
 * AU-020. THE CHECK DIGIT IS CHECKED HERE, with the same `Cedula` value object
 * `staff` and the patient register use, so the three cannot disagree about
 * what a valid document is.
 *
 * ⚠️ THIS USED TO BE `z.string().trim().max(10)` and a comment claiming the
 * `Cedula` value object and the database's `is_valid_cedula()` covered it.
 * BOTH CLAIMS WERE FALSE: `is_valid_cedula()` was attached to
 * `patient_identifier` and to nothing else, and nothing under `modules/auth/`
 * ever imported `Cedula`. `PATCH /auth/users/:id {"cedula":"abc"}` answered
 * 2xx, and this column is what `staff` serves and what RDACAA demands on every
 * row (REQ-021), so the typo would have surfaced months later as a report the
 * Ministry rejects. The base now carries `app_user_cedula_valid` as well; this
 * boundary is what turns its refusal into a message pointing at a field.
 *
 * An empty string is how a browser form sends a cleared field; it is read as
 * «sin cédula» and stored NULL. Most accounts have none — reception and
 * billing staff are not practitioners.
 */
const cedulaSchema = z
  .string({ error: 'Indique la cédula' })
  .trim()
  .refine((value) => value === '' || Cedula.isValid(value), {
    message: 'La cédula no es válida: revise los diez dígitos',
  })
  .transform((value) => (value === '' ? null : value));

export const listAccountsQuerySchema = z.object({
  includeInactive: explicitFlag,
  /** Name or email. Never the cedula: that confirms a person, it does not browse. */
  search: z.string().trim().max(120).optional(),
});
export class ListAccountsQueryDto extends createZodDto(
  listAccountsQuerySchema,
) {}

export const createAccountSchema = z.object({
  email: z
    .email('Indique un correo institucional válido')
    .max(255, 'El correo no puede superar 255 caracteres'),
  firstName: nameSchema('nombre'),
  lastName: nameSchema('apellido'),
  cedula: cedulaSchema.nullish(),
});
export class CreateAccountDto extends createZodDto(createAccountSchema) {}

/**
 * THE EMAIL IS ABSENT ON PURPOSE, and so is any password field.
 *
 *   - The email is the sign-in identifier and it is what every audit row of
 *     this person was written under. Editing it from an administration screen
 *     would quietly rewrite who did what; a person whose address really
 *     changes gets a new account and the old one deactivated.
 *   - AU-021 forbids an administrator choosing somebody else's password. There
 *     is no field for it here and no field for it on creation either, which is
 *     how the requirement is enforced rather than remembered.
 *   - `active` is absent too: AU-022 and AU-023 make activation its own
 *     endpoint, because deactivating has a second half — killing the open
 *     sessions — that a generic PATCH would invite somebody to forget.
 */
export const updateAccountSchema = z
  .object({
    firstName: nameSchema('nombre').optional(),
    lastName: nameSchema('apellido').optional(),
    cedula: cedulaSchema.nullish(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un cambio',
  });
export class UpdateAccountDto extends createZodDto(updateAccountSchema) {}

export const accountSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  cedula: z.string().nullable(),
  /** AU-022: `false` means the account cannot sign in and has no sessions. */
  active: z.boolean(),
  /** AU-005: whether the second factor is confirmed. Never its secret. */
  mfaEnabled: z.boolean(),
  /**
   * AU-021: the account exists and cannot sign in yet, because no credential
   * has been delivered. **D-013 has not been answered**, so nothing in this
   * API delivers one: the screen must show this and tell the administrator the
   * account is not usable yet.
   */
  credentialPending: z.boolean(),
});
export class AccountDto extends createZodDto(accountSchema) {}

export const accountListSchema = z.object({
  items: z.array(accountSchema).readonly(),
});
export class AccountListDto extends createZodDto(accountListSchema) {}

// --- Grants (AU-032) --------------------------------------------------------

export const grantSchema = z.object({
  roleId: z.uuid(),
  roleCode: z.string(),
  roleName: z.string(),
  /** `null` = todas las sedes. */
  siteId: z.uuid().nullable(),
});
export class GrantDto extends createZodDto(grantSchema) {}

export const grantListSchema = z.object({
  items: z.array(grantSchema).readonly(),
});
export class GrantListDto extends createZodDto(grantListSchema) {}

/**
 * AU-032. The whole set, not a delta: the screen sends the checkbox state, and
 * a set makes «lo que esta persona tiene» one fact instead of the outcome of a
 * sequence somebody could interrupt halfway.
 *
 * An EMPTY list is legitimate and means «esta persona no tiene ningún rol» —
 * an account that exists and can do nothing, which is what a suspension
 * without deactivation looks like.
 */
export const replaceGrantsSchema = z.object({
  grants: z
    .array(
      z.object({
        roleId: z.uuid('Seleccione un rol de la lista'),
        /** Absent or null = every site, including sites opened later. */
        siteId: z.uuid('Seleccione una sede de la lista').nullish(),
      }),
    )
    .max(50, 'Demasiados roles para una sola cuenta'),
});
export class ReplaceGrantsDto extends createZodDto(replaceGrantsSchema) {}

// --- Roles (AU-030..AU-034) -------------------------------------------------

/**
 * AU-030, mirrored from the CHECK `role_code_shape`. A role code is an
 * identifier, not a label: it appears in seeds, in logs and in support
 * conversations, and a lowercase or spaced code makes those unsearchable.
 */
const roleCodeSchema = z
  .string({ error: 'Indique el código del rol' })
  .trim()
  .regex(
    /^[A-Z][A-Z0-9_]{2,47}$/,
    'El código va en mayúsculas, sin espacios ni tildes, y tiene entre 3 y 48 caracteres. Por ejemplo: AUDITOR_EXTERNO',
  );

const roleNameSchema = z
  .string({ error: 'Indique el nombre del rol' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(120, 'El nombre no puede superar 120 caracteres');

const roleDescriptionSchema = z
  .string()
  .trim()
  .max(500, 'La descripción no puede superar 500 caracteres');

export const listRolesQuerySchema = z.object({
  includeInactive: explicitFlag,
});
export class ListRolesQueryDto extends createZodDto(listRolesQuerySchema) {}

export const createRoleSchema = z.object({
  code: roleCodeSchema,
  name: roleNameSchema,
  description: roleDescriptionSchema.nullish(),
});
export class CreateRoleDto extends createZodDto(createRoleSchema) {}

/**
 * The CODE is absent, and so is `isSystem`.
 *
 * The code identifies the role everywhere it is mentioned outside the
 * database, and `trg_role_protect_system` refuses to change it on a system
 * role anyway. `isSystem` says who OWNS the role — the product or the clinic —
 * and letting the application set it would make a role undeletable by the very
 * person who created it by mistake (AU-031).
 */
export const updateRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    description: roleDescriptionSchema.nullish(),
    /** AU-031: deactivating is what is offered instead of deleting. */
    active: z.boolean({ error: 'Indique si el rol está activo' }).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Indique al menos un cambio',
  });
export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

export const roleSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** AU-031: ships with the product. Editable, never deletable. */
  isSystem: z.boolean(),
  active: z.boolean(),
  /** How many accounts hold it right now. Zero is what makes it deletable. */
  liveGrants: z.number().int(),
});
export class RoleDto extends createZodDto(roleSchema) {}

export const roleListSchema = z.object({
  items: z.array(roleSchema).readonly(),
});
export class RoleListDto extends createZodDto(roleListSchema) {}

/**
 * AU-033. A plain string, and NOT `z.enum(PERMISSIONS)` — which is what this
 * was first, and it was wrong.
 *
 * With the enum, an unknown code is rejected by Zod as a generic schema
 * failure and the client receives `VALIDATION_FAILED`. The SPEC fixes
 * `UNKNOWN_PERMISSION` for exactly this case, and it fixes it because the two
 * mean different things to the screen: one is «este cuerpo está mal formado»,
 * the other is «ese permiso no existe en el sistema, actualiza la pantalla».
 * The service owns the check against the catalogue and names the offending
 * codes in the response.
 *
 * The closed list still reaches `clinica-web`: `GET /auth/permissions` is the
 * catalogue, and it is what the screen builds its checkboxes from.
 */
const permissionCodeSchema = z
  .string({ error: 'Indique el código del permiso' })
  .trim()
  .max(64);

export const replacePermissionsSchema = z.object({
  /**
   * The whole set, not a delta. An EMPTY list means «este rol no concede
   * nada», which is a real state: a role kept for its name while the clinic
   * decides what it should carry.
   */
  permissions: z.array(permissionCodeSchema).max(100),
});
export class ReplacePermissionsDto extends createZodDto(
  replacePermissionsSchema,
) {}

export const rolePermissionsSchema = z.object({
  roleId: z.uuid(),
  permissions: z.array(z.string()).readonly(),
  /**
   * AU-034. Present and empty when there is nothing to say; never a refusal.
   *
   * The operation ALREADY SUCCEEDED when this travels. A small clinic where
   * the owner is also the doctor is a real situation, and refusing it outright
   * pushes them to share one account — which is strictly worse for the trail,
   * because then nothing can be attributed to anybody.
   */
  warnings: z.array(z.string()).readonly(),
});
export class RolePermissionsDto extends createZodDto(rolePermissionsSchema) {}

export const permissionSchema = z.object({
  code: z.string(),
  /** Grouping for the screen: patient, agenda, record, billing, admin. */
  resource: z.string(),
  /** AU-033: what it allows, in Spanish, for whoever is granting it. */
  description: z.string(),
});
export class PermissionDto extends createZodDto(permissionSchema) {}

export const permissionListSchema = z.object({
  items: z.array(permissionSchema).readonly(),
});
export class PermissionListDto extends createZodDto(permissionListSchema) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type AccountResponse = z.infer<typeof accountSchema>;
export type AccountListResponse = z.infer<typeof accountListSchema>;
export type GrantListResponse = z.infer<typeof grantListSchema>;
export type RoleResponse = z.infer<typeof roleSchema>;
export type RoleListResponse = z.infer<typeof roleListSchema>;
export type RolePermissionsResponse = z.infer<typeof rolePermissionsSchema>;
export type PermissionListResponse = z.infer<typeof permissionListSchema>;
