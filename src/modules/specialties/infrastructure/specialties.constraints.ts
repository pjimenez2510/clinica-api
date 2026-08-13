import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * See `agenda.constraints.ts` for why each module registers its own.
 *
 * NOT REGISTERED HERE, deliberately: the unique indexes
 * (`specialty_code_unique`, `specialty_name_unique`,
 * `service_type_name_unique_per_specialty`) and the RESTRICT foreign keys.
 * Those are translated by the repository itself into the domain errors whose
 * codes the SPEC fixes — the registry cannot, because the right status for a
 * foreign-key refusal depends on the operation (422 on insert, 409 on
 * delete), and only the repository knows which one it ran. What remains here
 * is the safety net for writes that bypass the repository's translation.
 */
registerConstraintMeanings({
  // SP-021, SP-022: the duration range lives in the base as a CHECK, so a
  // write that dodges the DTO still answers per-field instead of 500.
  service_type_duration_range: {
    code: 'DURATION_OUT_OF_RANGE',
    field: 'durationMinutes',
    message: 'La duración debe estar entre 5 y 240 minutos, en múltiplos de 5',
  },
  duration_exception_range: {
    code: 'DURATION_OUT_OF_RANGE',
    field: 'durationMinutes',
    message: 'La duración debe estar entre 5 y 240 minutos, en múltiplos de 5',
  },
  // SP-005: at most one primary specialty per practitioner. The service
  // refuses a malformed set before writing; this is what a concurrent writer
  // that slips past it reads back.
  practitioner_specialty_one_primary: {
    code: 'PRIMARY_SPECIALTY_CONFLICT',
    field: 'items',
    message: 'El profesional ya tiene una especialidad principal',
  },
});
