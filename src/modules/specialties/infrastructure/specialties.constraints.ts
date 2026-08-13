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
 *
 * WHAT LEFT ON 13-08-2026 with the endpoints it belongs to:
 * `practitioner_specialty_one_primary` and `duration_exception_range` are now
 * registered by `staff.constraints.ts`, which owns ST-008 and ST-009. The base
 * duration stayed, because the catalogue is still this module's.
 */
registerConstraintMeanings({
  // SP-021: the duration range lives in the base as a CHECK, so a write that
  // dodges the DTO still answers per-field instead of 500.
  service_type_duration_range: {
    code: 'DURATION_OUT_OF_RANGE',
    field: 'durationMinutes',
    message: 'La duración debe estar entre 5 y 240 minutos, en múltiplos de 5',
  },
});
