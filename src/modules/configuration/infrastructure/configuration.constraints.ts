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
});
