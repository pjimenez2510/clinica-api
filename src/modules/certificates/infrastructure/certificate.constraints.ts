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
  /** CER-039. Issued by someone who did not attend, without saying why. */
  medical_certificate_issuer_reason_required: {
    code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
    field: 'issuedByOtherReason',
    message: 'Explique por qué emite el certificado de una atención que no registró', // prettier-ignore
  },
  /**
   * CER-039. The attending practitioner keeps no third-party reason.
   * UNREACHABLE through the service, which drops the reason when the issuer
   * attended; it answers an import or a `psql`, and points at the field.
   */
  medical_certificate_issuer_reason_only_for_others: {
    code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
    field: 'issuedByOtherReason',
    message: 'Quien registró la atención no deja motivo de emitir en lugar de otro', // prettier-ignore
  },
  /** CER-039. The third-party reason is never stored blank. */
  medical_certificate_issuer_reason_not_blank: {
    code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
    field: 'issuedByOtherReason',
    message: 'Explique por qué emite el certificado de una atención que no registró', // prettier-ignore
  },
  /** CER-044, D-106 §1, D-108. Three days before; maternity, its admission. */
  medical_certificate_rest_starts_at_most_3_days_before: {
    code: 'CERTIFICATE_REST_START_TOO_EARLY',
    field: 'restFrom',
    message: 'El reposo puede empezar, como mucho, tres días antes de la atención; el de maternidad, desde la fecha de ingreso o del parto', // prettier-ignore
  },
  /** CER-045, D-106 §4. Within eight days of the attention. */
  // On `type`: it is the rest itself that no longer fits this attention, and
  // it is where the service's error and the screen put it.
  medical_certificate_rest_issued_within_8_days: {
    code: 'CERTIFICATE_REST_ISSUED_TOO_LATE',
    field: 'type',
    message: 'Han pasado más de ocho días desde la atención: el reposo se emite desde una atención nueva', // prettier-ignore
  },
  /** CER-041. A rest starts no later than the day after it is issued. */
  medical_certificate_rest_starts_by_next_day: {
    code: 'CERTIFICATE_REST_START_TOO_LATE',
    field: 'restFrom',
    message: 'El reposo empieza, como muy tarde, el día siguiente a la emisión del certificado', // prettier-ignore
  },
  /** CER-030. A backdated or late rest without its reason. */
  medical_certificate_backdating_reason_required: {
    code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    field: 'backdatingReason',
    message: 'Explique por qué el reposo empieza antes del día de la atención o se emite después de ese día', // prettier-ignore
  },
  /**
   * CER-030. A rest of the day, issued the day, keeps no reason.
   * UNREACHABLE through the service, which drops it (`backdatingReasonOf`).
   */
  medical_certificate_backdating_reason_only_when_late: {
    code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    field: 'backdatingReason',
    message: 'Un reposo emitido el día de la atención y que empieza ese día no lleva motivo de retroactividad', // prettier-ignore
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
