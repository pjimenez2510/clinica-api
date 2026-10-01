import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the medical certificate means to the person who hit
 * it. Imported for its side effect by `certificates.module.ts`.
 *
 * THE SERVICE GETS THERE FIRST in every ordinary case, with the field named.
 * These entries are the same rules for a writer that did not come through the
 * service — an import, a `psql` — so the answer is a sentence and not a
 * constraint name.
 */
registerConstraintMeanings({
  /** CER-006. Rest dates only on a rest certificate, and the end not before the start. */
  medical_certificate_rest_range: {
    code: 'CERTIFICATE_REST_PERIOD_INVALID',
    field: 'restTo',
    message: 'El período de reposo no es válido: un reposo lleva inicio y fin, con el fin igual o posterior al inicio, y un certificado de asistencia no lleva período', // prettier-ignore
  },
  /** CER-011. Who, when and why, the three together or none. */
  medical_certificate_revocation_states_who_when_and_why: {
    code: 'CERTIFICATE_REVOCATION_REASON_REQUIRED',
    field: 'reason',
    message: 'Para anular un certificado hay que decir quién lo anula, cuándo y por qué', // prettier-ignore
  },
  /** CER-034. A contingency only on a rest certificate. */
  medical_certificate_contingency_only_on_rest: {
    code: 'CERTIFICATE_REST_PERIOD_INVALID',
    field: 'contingencyType',
    message: 'Un certificado de asistencia no lleva tipo de contingencia', // prettier-ignore
  },
  /** CER-035. Admission, birth and discharge together, exactly with maternity. */
  medical_certificate_maternity_dates_together: {
    code: 'CERTIFICATE_REST_PERIOD_INVALID',
    field: 'birthOn',
    message: 'Las fechas de ingreso, parto y alta van las tres juntas, y sólo con la contingencia de maternidad', // prettier-ignore
  },
  /** CER-030. The backdating reason is never stored blank. */
  medical_certificate_backdating_reason_not_blank: {
    code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    field: 'backdatingReason',
    message: 'Explique por qué el reposo empieza antes del día de la atención', // prettier-ignore
  },
  /**
   * CER-009. Two certificates of one site with the same number. The trigger
   * makes it unreachable; registered for the day something goes around it.
   */
  medical_certificate_site_number_unique: {
    code: 'CERTIFICATE_NUMBER_TAKEN',
    field: 'number',
    message: 'Ese número de certificado ya existe en la sede. Vuelva a intentarlo', // prettier-ignore
  },
});
