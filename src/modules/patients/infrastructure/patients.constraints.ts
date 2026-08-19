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
  /**
   * PA-008. Un fallecimiento anterior al nacimiento.
   *
   * El caso real es un año mal tecleado —2016 por 2026—, y produce una ficha
   * que dice que la persona murió diez años antes de nacer, con ella una edad
   * negativa en el reporte al ministerio. El CHECK compara resolviendo el
   * instante en `America/Guayaquil`, no en el huso de la sesión: sobre un
   * neonato que nace y muere el mismo día, ese desplazamiento es la diferencia
   * entre aceptar la fila y rechazarla.
   */
  patient_deceased_after_birth: {
    code: 'INVALID_DECEASED_DATE',
    field: 'deceasedAt',
    message:
      'La fecha de fallecimiento no puede ser anterior al nacimiento: revise el año',
  },
  /** PA-009. Una ficha no puede ser su propia madre. */
  patient_mother_not_self: {
    code: 'INVALID_MOTHER_LINK',
    field: 'motherPatientId',
    message: 'Esa es la misma historia: elija la ficha de la madre',
  },
});
