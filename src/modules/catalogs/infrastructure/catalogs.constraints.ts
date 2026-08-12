import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/** See `agenda.constraints.ts` for why each module registers its own. */
registerConstraintMeanings({
  catalog_concept_code_temporal_unique: {
    code: 'CONCEPT_ALREADY_VALID',
    field: 'code',
    message: 'Ese código ya tiene una definición vigente en el mismo periodo',
  },
});
