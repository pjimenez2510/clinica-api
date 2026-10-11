import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * See `agenda.constraints.ts` for why each module registers its own.
 *
 * NOT REGISTERED HERE, deliberately: `holiday_date_scope_unique`. The
 * repository translates it into `HolidayDuplicateError` so the response is a
 * 409 with the code CF-061 fixes; the registry could only change the message,
 * and a unique violation defaults to 409 anyway — two places saying the same
 * thing is two places that can end up saying different things.
 *
 * What IS here is the safety net for the range CHECKs of CF-065, for writes
 * that never see `assertParametersInRange`: a data import, a migration script,
 * a `psql` at two in the morning. The message names the range, which is the
 * half of CF-065 that matters — «fuera de rango» without the range sends the
 * reader to the source code.
 */
registerConstraintMeanings({
  site_parameter_min_lead_minutes_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'minLeadMinutes',
    message: 'La antelación mínima va de 0 a 10080 minutos (7 días)',
  },
  site_parameter_max_lead_days_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'maxLeadDays',
    message: 'La antelación máxima va de 1 a 730 días (2 años)',
  },
  site_parameter_overbooking_cap_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'overbookingCap',
    message: 'El tope de sobrecupos va de 0 a 20',
  },
  // D-021. El átomo de la agenda. Mismo motivo que los tres de arriba: para
  // la escritura que no pasa por `assertParametersInRange`.
  site_parameter_slot_atom_minutes_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'slotAtomMinutes',
    message: 'El turno de la agenda va de 5 a 60 minutos, de 5 en 5',
  },
  // AG-066, AG-094 (E5). Mismo motivo que los de arriba: la escritura que no
  // pasa por `assertParametersInRange`. El número que la sede elige dentro del
  // rango es decisión de la clínica (D-040); los extremos no.
  site_parameter_waitlist_max_contact_attempts_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'waitlistMaxContactAttempts',
    message: 'Los intentos de contacto de la lista de espera van de 1 a 10',
  },
  // AG-142. El margen de llegada tardía, para la escritura que no pasa por
  // `assertParametersInRange`.
  site_parameter_late_arrival_grace_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'lateArrivalGraceMinutes',
    message: 'El margen de llegada tardía va de 0 a 240 minutos (4 horas)',
  },
  // ORD-063, ORD-065, ORD-046. Mismo motivo: la escritura que no pasa por
  // `assertParametersInRange`.
  site_parameter_critical_notice_within_minutes_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'criticalNoticeWithinMinutes',
    message:
      'El plazo para avisar un valor crítico va de 5 a 1440 minutos (un día)',
  },
  site_parameter_unmatched_result_deadline_hours_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'unmatchedResultDeadlineHours',
    message:
      'El plazo de los resultados sin orden va de 1 a 168 horas (una semana)',
  },
  // El rol lo arbitra la clave foránea, como la sede de un feriado: el
  // servicio no lee antes y no pierde la ventana de en medio. `ROLE_NOT_FOUND`
  // es de `auth`, dueño de los roles; esto es el mapeo de un rechazo.
  site_parameter_critical_escalation_role_id_fkey: {
    code: 'ROLE_NOT_FOUND',
    field: 'criticalEscalationRoleId',
    message: 'El rol indicado no existe. Actualice la lista de roles',
  },
  // ORD-179. La persona de guardia, por la clave foránea; y rol o persona,
  // nunca los dos.
  site_parameter_critical_escalation_user_id_fkey: {
    code: 'USER_NOT_FOUND',
    field: 'criticalEscalationUserId',
    message: 'La persona indicada no existe. Actualice la lista',
  },
  site_parameter_one_escalation: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'criticalEscalationUserId',
    message:
      'La guardia es un rol o una persona, no los dos: quite el rol para nombrar a una persona',
  },
  site_parameter_unmatched_result_owner_role_id_fkey: {
    code: 'ROLE_NOT_FOUND',
    field: 'unmatchedResultOwnerRoleId',
    message: 'El rol indicado no existe. Actualice la lista de roles',
  },
  // EN-272. La línea de la TA, para la escritura que no pasa por el dominio.
  site_parameter_bp_reference_systolic_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'bpReferenceSystolic',
    message: 'La línea de la tensión sistólica va de 100 a 200 mmHg',
  },
  site_parameter_bp_reference_diastolic_range: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'bpReferenceDiastolic',
    message: 'La línea de la tensión diastólica va de 60 a 120 mmHg',
  },
  site_parameter_bp_reference_coherent: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'bpReferenceDiastolic',
    message:
      'La línea de la tensión diastólica tiene que quedar por debajo de la sistólica',
  },
  site_parameter_lead_window_coherent: {
    code: 'PARAM_OUT_OF_RANGE',
    field: 'minLeadMinutes',
    message:
      'La antelación mínima no puede superar la máxima: la sede se quedaría sin ninguna hora reservable',
  },
  // CF-060: un feriado sin nombre no es un feriado, es una fecha suelta que
  // nadie sabrá explicar en la agenda.
  holiday_name_not_blank: {
    code: 'HOLIDAY_NAME_REQUIRED',
    field: 'name',
    message: 'Indique el nombre del feriado',
  },
  // AG-092: marcar como laborable un feriado para una sede que no existe. La
  // clave foránea responde, así que el servicio no tiene que leer antes y
  // perder la ventana de en medio — igual que `practitioner_site_site_id_fkey`
  // en `staff`. El código es `SITE_NOT_FOUND` porque la sede es de
  // `organization`, dueña de ese código: esto es el mapeo de un rechazo de
  // PostgreSQL, no una clase de error nueva de este módulo.
  holiday_site_exception_site_id_fkey: {
    code: 'SITE_NOT_FOUND',
    field: 'siteId',
    message: 'La sede indicada no existe. Actualice la lista de sedes',
  },
});
