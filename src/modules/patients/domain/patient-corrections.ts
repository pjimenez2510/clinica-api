import {
  parseClinicalDate,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

/**
 * What may be corrected on a chart, and what a correction leaves behind
 * (PA-031, REQ-113, D-032).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. THE LIST LIVES HERE AND IN THE DATABASE, NOWHERE ELSE IN THE CODE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_change_history_field_known` repeats it as a CHECK, for the same
 * reason the cedula check digit is repeated there and the recordable subset of
 * priority groups is: an import, a data migration or an `INSERT` through
 * `psql` never passes through this file. The service explains what to correct
 * while the patient is still at the desk; the database makes the wrong row
 * impossible.
 *
 * The DTO is BUILT from this list rather than repeating it — a second copy in
 * the transport layer is the one nobody remembers to edit, and the symptom
 * would be a form offering a field the database refuses to trace.
 */

/**
 * Exactly the fields `patient_change_history_field_known` admits, in its order.
 *
 * ⚠️ `mrn` IS ABSENT AND MUST STAY ABSENT (PA-002). It is the identity anchor,
 * not a datum of the chart: a history row saying it changed would be a trail
 * of something the system does not permit. `isProvisional` and `mergedIntoId`
 * are absent too — they are not corrected, they are MOVED, by PA-015 and by a
 * merge, each with its own trail.
 */
export const CORRECTABLE_PATIENT_FIELDS = [
  'familyName',
  'secondFamilyName',
  'givenName',
  'secondGivenName',
  'sex',
  'birthDate',
  'birthDateEstimated',
  'deceasedAt',
  'phone',
  'email',
  'residenceAddressLine',
  'bloodType',
  'ethnicityConceptId',
  'nationalityConceptId',
  'residenceParishConceptId',
  'genderIdentityConceptId',
  /**
   * PA-053. El país, como CÓDIGO alpha-3 y no como referencia a un concepto.
   *
   * No es `nationalityConceptId`, que es la nacionalidad o pueblo indígena del
   * RDACAA. Que el rastro guarde `VEN` y no un `uuid` es lo que hace legible el
   * valor anterior de una corrección sin resolver nada.
   */
  'countryOfNationalityCode',
  'motherPatientId',
] as const;

export type CorrectablePatientField =
  (typeof CORRECTABLE_PATIENT_FIELDS)[number];

export function isCorrectablePatientField(
  field: string,
): field is CorrectablePatientField {
  return (CORRECTABLE_PATIENT_FIELDS as readonly string[]).includes(field);
}

/**
 * One field of a correction, as `patient_change_history` stores it.
 *
 * BOTH SIDES AS TEXT, which is what lets one table hold dates, instants, uuids
 * and enumerations without a column per type or a JSON document. `null` means
 * "had no value" or "was cleared", which is a real change and has to be
 * recordable.
 */
export interface PatientFieldChange {
  field: CorrectablePatientField;
  valueBefore: string | null;
  valueAfter: string | null;
}

/** The chart as it stands, every correctable field already in its text form. */
export type PatientCorrectionSnapshot = Readonly<
  Record<CorrectablePatientField, string | null>
>;

/**
 * What the caller asked to change.
 *
 * ABSENT MEANS "DO NOT TOUCH"; `null` means "clear it". The two are different
 * requests and a `Partial` is what keeps them different — collapsing them
 * would make every unsent field an erasure, which on a chart is data loss
 * dressed as an update.
 *
 * Values arrive in their natural form: a date as `YYYY-MM-DD`, a flag as a
 * boolean, everything else as the string that is stored. The closed lists
 * (`sex`, `bloodType`) are validated by the DTO, which is the boundary; this
 * file decides how a value is WRITTEN DOWN, not whether it is admissible.
 */
export interface PatientCorrectionRequest {
  familyName?: string;
  secondFamilyName?: string | null;
  givenName?: string;
  secondGivenName?: string | null;
  sex?: string;
  birthDate?: string;
  birthDateEstimated?: boolean;
  /** A calendar date. Stored as the instant it begins in Ecuador. */
  deceasedAt?: string | null;
  phone?: string | null;
  email?: string | null;
  residenceAddressLine?: string | null;
  bloodType?: string | null;
  ethnicityConceptId?: string | null;
  nationalityConceptId?: string | null;
  residenceParishConceptId?: string | null;
  genderIdentityConceptId?: string | null;
  /** PA-053. `ISO 3166-1 alpha-3`, ya en mayúsculas: lo normaliza el DTO. */
  countryOfNationalityCode?: string | null;
  motherPatientId?: string | null;
}

/**
 * How one requested value is written down.
 *
 * ONE FUNCTION FOR BOTH SIDES OF THE COMPARISON: the snapshot of what the
 * chart holds is produced in the same forms (see the adapter), so "unchanged"
 * is decided by comparing two strings that were built the same way. Two
 * formatting rules — one for the stored value, one for the incoming one —
 * would report a change every time somebody re-sent the value already there,
 * and `patient_change_history_value_changed` would then refuse the row.
 *
 * ⚠️ `deceasedAt` IS THE ONE THAT CONVERTS. It arrives as a date, because a
 * date is what the person at the desk knows, and it is stored as a
 * `timestamptz`: the instant that date BEGINS IN ECUADOR. Midnight UTC would
 * be 19:00 of the day before here, which reads back as a death one day early
 * and, for someone who dies on the day they were born, as a death before the
 * birth.
 */
export function correctionTextOf(
  field: CorrectablePatientField,
  value: string | boolean | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;

  if (field === 'birthDateEstimated') return value === true ? 'true' : 'false';

  if (field === 'deceasedAt' && typeof value === 'string') {
    return startOfClinicalDay(parseClinicalDate(value)).toISOString();
  }

  return typeof value === 'boolean' ? String(value) : value;
}

/**
 * The fields that ACTUALLY change, and only those.
 *
 * A field re-sent with the value it already held produces no row: it is not a
 * correction, and `patient_change_history_value_changed` would refuse it
 * anyway — a trail row showing the same value on both sides is noise that
 * makes the change somebody is looking for harder to find. Since the update
 * is derived from this list too, such a field is not even written.
 *
 * The order follows {@link CORRECTABLE_PATIENT_FIELDS} rather than the order
 * of the request's keys, so two callers sending the same correction leave the
 * same trail.
 */
export function planCorrection(
  current: PatientCorrectionSnapshot,
  requested: PatientCorrectionRequest,
): readonly PatientFieldChange[] {
  const asked = requested as Record<string, string | boolean | null>;

  return CORRECTABLE_PATIENT_FIELDS.filter(
    (field) => field in asked && asked[field] !== undefined,
  )
    .map((field) => ({
      field,
      valueBefore: current[field],
      valueAfter: correctionTextOf(field, asked[field]),
    }))
    .filter((change) => change.valueBefore !== change.valueAfter);
}
