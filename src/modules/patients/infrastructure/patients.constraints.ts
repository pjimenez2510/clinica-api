import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/** See `agenda.constraints.ts` for why each module registers its own. */
registerConstraintMeanings({
  patient_identifier_cedula_valid: {
    code: 'INVALID_CEDULA',
    field: 'value',
    message: 'La cédula no es válida: el dígito verificador no corresponde',
  },
  patient_identifier_active_unique: {
    code: 'DUPLICATE_IDENTIFIER',
    field: 'value',
    message: 'Ya existe un paciente registrado con ese documento',
  },
});
