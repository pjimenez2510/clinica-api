import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ST-010: un profesional desactivado viaja solo si se pide EXPLÍCITAMENTE.
import { explicitFlag } from '../../../shared/http/query-flag';

import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';

/**
 * The staff contract, requests and responses.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`. Wording follows ADR-005 — a complete
 * sentence, capitalised, no trailing period, telling the user what to do.
 */

/**
 * `z.iso.date` guarantees the FORMAT; `parseClinicalDate` additionally rejects
 * impossible calendar dates (2026-02-30) and brands the result, so everything
 * past this boundary carries `ClinicalDate` and the compiler refuses raw
 * strings. Same helper as `agenda.dto.ts`, and deliberately copied rather than
 * shared: four lines, and a shared DTO helper is a file two modules have to
 * agree on before either can change a message.
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

export const listPractitionersQuerySchema = z.object({
  /** ST-010: a deactivated practitioner travels only when asked for. */
  includeInactive: explicitFlag,
});
/** Query of GET /staff/practitioners. */
export class ListPractitionersQueryDto extends createZodDto(
  listPractitionersQuerySchema,
) {}

export const listScheduleRulesQuerySchema = z.object({
  /** ST-041: rules already closed explain last month's agenda. */
  includeClosed: explicitFlag,
});
/** Query of GET /staff/practitioners/:practitionerId/schedule-rules. */
export class ListScheduleRulesQueryDto extends createZodDto(
  listScheduleRulesQuerySchema,
) {}

// --- The practitioner (ST-001..ST-003, ST-006, ST-010) ---------------------

/**
 * ST-001. THE CHECK DIGIT IS CHECKED HERE, so a typo answers with a message
 * pointing at the field instead of a RDACAA row the Ministry rejects months
 * later. The algorithm is the `Cedula` value object's — the same one the
 * patient register and `auth` use — so the three cannot disagree about what a
 * valid document is.
 *
 * The base backs it since `app_user_cedula_valid`; `auth` was the door that
 * had neither, and now both write through the same rule.
 *
 * An empty string is how a browser form sends a cleared field; it is read as
 * «no cedula» and stored NULL.
 */
const cedulaSchema = z
  .string({ error: 'Indique la cédula' })
  .trim()
  .refine((value) => value === '' || Cedula.isValid(value), {
    message: 'La cédula no es válida: revise los diez dígitos',
  })
  .transform((value) => (value === '' ? null : value));

const acessRegistrationSchema = z
  .string({ error: 'Indique el registro ACESS' })
  .trim()
  .max(32, 'El registro ACESS no puede superar 32 caracteres')
  .transform((value) => (value === '' ? null : value));

const mspCodeSchema = z
  .string({ error: 'Indique el código MSP' })
  .trim()
  .max(32, 'El código MSP no puede superar 32 caracteres')
  .transform((value) => (value === '' ? null : value));

/**
 * The account is named and never created here: `auth` owns it, and a
 * receptionist has an account with no clinical profile at all. That separation
 * is the whole reason `practitioner` is a table of its own.
 */
export const createPractitionerSchema = z.object({
  userId: z.uuid('Seleccione una cuenta de usuario de la lista'),
  mspCode: mspCodeSchema.nullish(),
  schedulable: z.boolean({ error: 'Indique si toma citas' }).optional(),
});
/** Body of POST /staff/practitioners (`staff:manage`). */
export class CreatePractitionerDto extends createZodDto(
  createPractitionerSchema,
) {}

/**
 * The account the profile hangs from is absent on purpose: moving a clinical
 * profile from one account to another would reassign every note that
 * practitioner ever signed. Creating a new profile is the honest way.
 */
export const updatePractitionerSchema = z
  .object({
    mspCode: mspCodeSchema.nullish(),
    schedulable: z.boolean({ error: 'Indique si toma citas' }).optional(),
    active: z.boolean({ error: 'Indique si el profesional está activo' }).optional(), // prettier-ignore
    cedula: cedulaSchema.nullish(),
    acessRegistration: acessRegistrationSchema.nullish(),
    acessExpiresOn: clinicalDateField(
      'Indique la caducidad del ACESS en formato AAAA-MM-DD',
    ).nullish(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'Indique al menos un cambio',
    },
  );
/** Body of PATCH /staff/practitioners/:practitionerId; an empty body is refused rather than answered with an unchanged profile. */
export class UpdatePractitionerDto extends createZodDto(
  updatePractitionerSchema,
) {}

const primarySpecialtySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
});

export const practitionerSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  /** ST-001. Stored on the account, never duplicated here. */
  cedula: z.string().nullable(),
  /** ST-002. */
  acessRegistration: z.string().nullable(),
  acessExpiresOn: z.iso.date().nullable(),
  /** ST-003: what RDACAA demands on every attention (REQ-021). */
  mspCode: z.string().nullable(),
  /** ST-006. */
  schedulable: z.boolean(),
  /** ST-010: `false` means deactivated, never deleted. */
  active: z.boolean(),
  /** ST-008: the one the agenda lists. */
  primarySpecialty: primarySpecialtySchema.nullable(),
  /** ST-007. */
  siteIds: z.array(z.uuid()).readonly(),
});
/** Response of reading, creating and updating one practitioner. */
export class PractitionerDto extends createZodDto(practitionerSchema) {}

export const practitionerListSchema = z.object({
  items: z.array(practitionerSchema).readonly(),
});
/** Response of GET /staff/practitioners. */
export class PractitionerListDto extends createZodDto(practitionerListSchema) {}

// --- ACESS (ST-004, ST-005) ------------------------------------------------

export const acessExpiryQuerySchema = z.object({
  /**
   * ST-005 fixes 30 days as what the clinic is entitled to; it is the default
   * and not the only question anybody may ask. Capped at a year because a
   * window wider than the habilitación itself lists everybody.
   */
  withinDays: z.coerce
    .number({ error: 'Indique los días de antelación' })
    .int('Los días deben ser un número entero')
    .min(0, 'Los días no pueden ser negativos')
    .max(365, 'El aviso no puede anticiparse más de un año')
    .default(30),
});
/** Query of GET /staff/practitioners/acess-expiring (ST-005). */
export class AcessExpiryQueryDto extends createZodDto(acessExpiryQuerySchema) {}

export const acessExpiryWarningSchema = z.object({
  practitionerId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  acessRegistration: z.string(),
  acessExpiresOn: z.iso.date(),
  /** Negative when it already ran out: expired is the most urgent warning. */
  daysToExpiry: z.number().int(),
});

export const acessExpiryListSchema = z.object({
  items: z.array(acessExpiryWarningSchema).readonly(),
});
/** Response of GET /staff/practitioners/acess-expiring. */
export class AcessExpiryListDto extends createZodDto(acessExpiryListSchema) {}

/**
 * ST-004. What a caller about to sign gets when the habilitación IS valid; an
 * expired or missing one never reaches this shape, it is refused with
 * `ACESS_EXPIRED` or `ACESS_MISSING`.
 */
export const signingEligibilitySchema = z.object({
  practitionerId: z.uuid(),
  eligible: z.literal(true),
  acessExpiresOn: z.iso.date(),
  daysToExpiry: z.number().int(),
  /** ST-005: valid, and worth warning about. */
  expiringSoon: z.boolean(),
});
/** Response of GET /staff/practitioners/:practitionerId/signing-eligibility. */
export class SigningEligibilityDto extends createZodDto(
  signingEligibilitySchema,
) {}

// --- Sites (ST-007) --------------------------------------------------------

export const assignSitesSchema = z.object({
  /**
   * The WHOLE list of sites the practitioner attends at — replace-set, which
   * is why the route is a PUT. An empty array is legal and means «attends
   * nowhere for now», which is what happens to somebody on long leave.
   */
  siteIds: z.array(z.uuid('Seleccione una sede de la lista')),
});
/** Body of PUT /staff/practitioners/:practitionerId/sites. */
export class AssignSitesDto extends createZodDto(assignSitesSchema) {}

export const practitionerSiteSchema = z.object({
  siteId: z.uuid(),
  name: z.string(),
  active: z.boolean(),
});

export const practitionerSiteListSchema = z.object({
  items: z.array(practitionerSiteSchema).readonly(),
});
/** Response of reading and replacing a practitioner's sites. */
export class PractitionerSiteListDto extends createZodDto(
  practitionerSiteListSchema,
) {}

// --- Specialties (ST-008) --------------------------------------------------

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
     * composite primary key would answer with a constraint violation the form
     * cannot point at a field.
     */
    .refine(
      (items) =>
        new Set(items.map((item) => item.specialtyId)).size === items.length,
      { message: 'Hay una especialidad repetida en la asignación' },
    ),
});
/** Body of PUT /staff/practitioners/:practitionerId/specialties. */
export class AssignSpecialtiesDto extends createZodDto(
  assignSpecialtiesSchema,
) {}

export const practitionerSpecialtySchema = z.object({
  specialtyId: z.uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  isPrimary: z.boolean(),
});

export const practitionerSpecialtyListSchema = z.object({
  items: z.array(practitionerSpecialtySchema).readonly(),
});
/** Response of reading and replacing a practitioner's specialties. */
export class PractitionerSpecialtyListDto extends createZodDto(
  practitionerSpecialtyListSchema,
) {}

// --- Duration exceptions (ST-009) ------------------------------------------

/**
 * The FLOOR of SP-022, mirrored from the `duration_exception_range` CHECK.
 *
 * NOT THE WHOLE RULE SINCE D-021: the exception also has to be a multiple of
 * the site's slot atom, which lives in `site_parameter` and therefore takes a
 * read. `PractitionerAssignmentsService` does it and refuses with
 * `DURATION_NOT_SLOT_MULTIPLE` naming the atom. What stays here needs no read
 * — and is not redundant, since the atom's own range is 5..60 in steps of 5.
 */
const durationMinutesSchema = z
  .number({ error: 'Indique la duración en minutos' })
  .int('La duración debe ser un número entero de minutos')
  .min(5, 'La duración mínima es de 5 minutos')
  .max(240, 'La duración máxima es de 240 minutos')
  .refine((value) => value % 5 === 0, {
    message: 'La duración debe ir en múltiplos de 5 minutos',
  });

export const setDurationExceptionSchema = z.object({
  durationMinutes: durationMinutesSchema,
});
/** Body of PUT /staff/practitioners/:practitionerId/duration-exceptions/:serviceTypeId. */
export class SetDurationExceptionDto extends createZodDto(
  setDurationExceptionSchema,
) {}

export const practitionerDurationSchema = z.object({
  serviceTypeId: z.uuid(),
  serviceTypeName: z.string(),
  specialtyId: z.uuid(),
  specialtyName: z.string(),
  baseMinutes: z.number().int(),
  exceptionMinutes: z.number().int().nullable(),
  /** exception → base, resolved through the D-010 hierarchy. */
  resolvedMinutes: z.number().int(),
});

export const practitionerDurationListSchema = z.object({
  items: z.array(practitionerDurationSchema).readonly(),
});
/** Response of GET /staff/practitioners/:practitionerId/duration-exceptions. */
export class PractitionerDurationListDto extends createZodDto(
  practitionerDurationListSchema,
) {}

// --- Schedule rules (ST-040..ST-046) ---------------------------------------

/**
 * `HH:MM`, wall clock and never an instant: this is "Mondays from 08:00", and
 * it means the same thing whichever server reads it. `23:59` and not `24:00`
 * is the documented way to say "until midnight" — see the CHECK
 * `schedule_rule_time_order`, which explains what `24:00` does to the driver.
 */
const wallClockSchema = z
  .string({ error: 'Indique la hora en formato HH:MM' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Indique la hora en formato HH:MM, de 00:00 a 23:59'); // prettier-ignore

const weekdaySchema = z
  .number({ error: 'Indique el día de la semana' })
  .int()
  .min(1, 'El día va de 1 (lunes) a 7 (domingo)')
  .max(7, 'El día va de 1 (lunes) a 7 (domingo)');

/**
 * D-021: NO HAY `slotMinutes` EN ESTE ESQUEMA, y su ausencia es la decisión.
 * La rejilla dejó de ser un número por regla y es el átomo de la sede
 * (`site_parameter.slot_atom_minutes`), así que la pantalla de horarios tiene
 * un campo menos que decidir y no puede volver a desencajar con la duración de
 * un tipo de atención.
 */
export const createScheduleRuleSchema = z.object({
  /** ST-046: a rule belongs to exactly one site. */
  siteId: z.uuid('Seleccione la sede de la lista'),
  weekday: weekdaySchema,
  startTime: wallClockSchema,
  endTime: wallClockSchema,
  /** ST-041: every rule carries validity. */
  validFrom: clinicalDateField('Indique el inicio de vigencia en formato AAAA-MM-DD'), // prettier-ignore
  validTo: clinicalDateField('Indique el fin de vigencia en formato AAAA-MM-DD').nullish(), // prettier-ignore
});
/** Body of POST /staff/practitioners/:practitionerId/schedule-rules. */
export class CreateScheduleRuleDto extends createZodDto(
  createScheduleRuleSchema,
) {}

export const updateScheduleRuleSchema = z
  .object({
    siteId: z.uuid('Seleccione la sede de la lista').optional(),
    weekday: weekdaySchema.optional(),
    startTime: wallClockSchema.optional(),
    endTime: wallClockSchema.optional(),
    validFrom: clinicalDateField('Indique el inicio de vigencia en formato AAAA-MM-DD').optional(), // prettier-ignore
    validTo: clinicalDateField('Indique el fin de vigencia en formato AAAA-MM-DD').nullish(), // prettier-ignore
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: 'Indique al menos un cambio',
    },
  );
/** Body of PATCH /staff/schedule-rules/:ruleId; an empty body is refused. */
export class UpdateScheduleRuleDto extends createZodDto(
  updateScheduleRuleSchema,
) {}

export const scheduleRuleSchema = z.object({
  id: z.uuid(),
  practitionerId: z.uuid(),
  siteId: z.uuid(),
  weekday: z.number().int(),
  startTime: z.string(),
  endTime: z.string(),
  validFrom: z.iso.date(),
  /** `null` means still in force (ST-041). */
  validTo: z.iso.date().nullable(),
  active: z.boolean(),
});
/** One rule; no route returns it on its own, it travels inside the list and the outcome below. */
export class ScheduleRuleDto extends createZodDto(scheduleRuleSchema) {}

export const scheduleRuleListSchema = z.object({
  items: z.array(scheduleRuleSchema).readonly(),
});
/** Response of GET /staff/practitioners/:practitionerId/schedule-rules. */
export class ScheduleRuleListDto extends createZodDto(scheduleRuleListSchema) {}

/**
 * ST-043. The appointments the change left outside the new hours — LISTED,
 * never cancelled and never moved. Empty is the normal answer and is still
 * sent, so the screen never has to guess whether the list was computed.
 */
export const scheduleConflictSchema = z.object({
  agendaEntryId: z.uuid(),
  siteId: z.uuid(),
  date: z.iso.date(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});

export const scheduleRuleOutcomeSchema = z.object({
  rule: scheduleRuleSchema,
  conflicts: z.array(scheduleConflictSchema).readonly(),
});
/** Response of creating, updating and closing a schedule rule. */
export class ScheduleRuleOutcomeDto extends createZodDto(
  scheduleRuleOutcomeSchema,
) {}

/** Response types inferred from the published schemas; see agenda.dto.ts. */
export type PractitionerResponse = z.infer<typeof practitionerSchema>;
export type PractitionerListResponse = z.infer<typeof practitionerListSchema>;
export type AcessExpiryListResponse = z.infer<typeof acessExpiryListSchema>;
export type SigningEligibilityResponse = z.infer<typeof signingEligibilitySchema>; // prettier-ignore
export type PractitionerSiteListResponse = z.infer<typeof practitionerSiteListSchema>; // prettier-ignore
export type PractitionerSpecialtyListResponse = z.infer<typeof practitionerSpecialtyListSchema>; // prettier-ignore
export type PractitionerDurationListResponse = z.infer<typeof practitionerDurationListSchema>; // prettier-ignore
export type ScheduleRuleListResponse = z.infer<typeof scheduleRuleListSchema>;
export type ScheduleRuleOutcomeResponse = z.infer<typeof scheduleRuleOutcomeSchema>; // prettier-ignore
