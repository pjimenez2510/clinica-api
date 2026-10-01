import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the staff file means to the administrator who hit
 * it.
 *
 * Lives HERE, beside the repository and two directories from the migration
 * that creates these constraints, so adding one is a change inside the module
 * that owns it — never an edit to a shared file. Imported for its side effect
 * by `staff.module.ts`.
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 *
 * TWO OF THEM ARRIVED FROM `specialties.constraints.ts` ON 13-08-2026 with the
 * endpoints they belong to: `practitioner_specialty_one_primary` (ST-008) and
 * `duration_exception_range` (ST-009). `service_type_duration_range` stayed
 * behind, because the base duration is still the catalogue's.
 */
registerConstraintMeanings({
  // ST-042 (AG-106), THE guarantee of S2. The service does not check for an
  // overlap and cannot: two administrators editing the same doctor's Monday
  // both read "free". This is what the loser of that race is told.
  schedule_rule_no_overlap: {
    code: 'SCHEDULE_RULE_OVERLAP',
    field: 'startTime',
    message: 'El profesional ya tiene otro horario en esa sede ese día a esa hora', // prettier-ignore
  },
  // ST-042 entre sedes (D-070): el mismo código, porque es la misma regla.
  schedule_rule_no_overlap_across_sites: {
    code: 'SCHEDULE_RULE_OVERLAP',
    field: 'startTime',
    message: 'El profesional ya tiene horario ese día a esa hora en otra sede: un horario vive en un solo sitio', // prettier-ignore
  },
  // D-021 se llevó `schedule_rule_slot_fits` y `schedule_rule_slot_positive`:
  // los dos leían `practitioner_schedule_rule.slot_minutes`, que ya no existe.
  // «El turno cabe en la franja» lo comprueba ahora `scheduleRuleProblems` con
  // el átomo de la sede, porque un `CHECK` no puede consultar `site_parameter`.
  schedule_rule_time_order: {
    code: 'INVALID_SCHEDULE_RULE',
    field: 'endTime',
    message: 'La hora de fin debe ser posterior a la de inicio y anterior a medianoche', // prettier-ignore
  },
  schedule_rule_weekday_iso: {
    code: 'INVALID_SCHEDULE_RULE',
    field: 'weekday',
    message: 'Elija un día de la semana, de lunes a domingo',
  },
  // ST-041: an empty validity is a rule that never rules — and, because an
  // empty range overlaps nothing, one that would also slip past ST-042.
  schedule_rule_validity_not_empty: {
    code: 'INVALID_SCHEDULE_RULE',
    field: 'validTo',
    message: 'El fin de vigencia debe ser posterior al inicio',
  },
  // ST-008: at most one primary specialty per practitioner. The service
  // refuses a malformed set before writing; this is what a concurrent writer
  // that slips past it reads back.
  practitioner_specialty_one_primary: {
    code: 'PRIMARY_SPECIALTY_CONFLICT',
    field: 'items',
    message: 'El profesional ya tiene una especialidad principal',
  },
  // ST-009: the duration range lives in the base as a CHECK, so a write that
  // dodges the DTO still answers per field instead of 500.
  duration_exception_range: {
    code: 'DURATION_OUT_OF_RANGE',
    field: 'durationMinutes',
    message: 'La duración debe estar entre 5 y 240 minutos, en múltiplos de 5',
  },
  // One account, one clinical profile. Prisma's own index name, from
  // `20260806022931_clinical_core`.
  practitioner_user_id_key: {
    code: 'PRACTITIONER_DUPLICATE',
    field: 'userId',
    message: 'Esa cuenta ya tiene ficha profesional',
  },
  practitioner_user_id_fkey: {
    code: 'USER_NOT_FOUND',
    field: 'userId',
    message: 'La cuenta indicada no existe. Créela antes de darle ficha profesional', // prettier-ignore
  },
  // ST-001: the cedula is unique across the whole system, and it lives on the
  // account. The index is Prisma's, from the first migration.
  app_user_cedula_key: {
    code: 'CEDULA_TAKEN',
    field: 'cedula',
    message: 'Esa cédula ya pertenece a otra cuenta del sistema',
  },
  // ST-007: assigning a site that does not exist. The foreign key answers so
  // the service does not have to read first and lose the window in between.
  practitioner_site_site_id_fkey: {
    code: 'SITE_NOT_FOUND',
    field: 'siteIds',
    message: 'Alguna de las sedes indicadas no existe. Actualice la lista',
  },
});
