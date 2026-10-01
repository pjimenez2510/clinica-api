import { addDays, type ClinicalDate } from '../../../shared/domain/clinic-time';

import {
  CertificateRestPeriodInvalidError,
  CertificateTypeNotSupportedError,
  type RestPeriodField,
  type RestPeriodProblem,
} from './certificate.errors';

/**
 * The medical certificate of form SNS-MSP/HCU-form.117/2021: its types, its
 * rest period, the attentions that admit one, and what the IESS needs to know.
 *
 * PURE: no clock, no storage. Dates arrive as `ClinicalDate` — calendar dates
 * in Ecuador — because `rest_from` and `rest_to` are `date` columns, not
 * instants.
 */

/** `CertificateType` of the schema. Declared here: no module imports another. */
export type CertificateType =
  'ATTENDANCE' | 'MEDICAL_REST' | 'FITNESS' | 'DISABILITY_SUPPORT';

/** Every value of the enum, for the transport to validate against. */
export const CERTIFICATE_TYPES: readonly CertificateType[] = [
  'ATTENDANCE',
  'MEDICAL_REST',
  'FITNESS',
  'DISABILITY_SUPPORT',
];

/** CER-005. The two types that ARE a form 117. */
export type IssuableCertificateType = 'ATTENDANCE' | 'MEDICAL_REST';

/** `EncounterStatus` of the schema, declared here for the same reason. */
export type EncounterStatus =
  | 'OPEN'
  | 'ON_HOLD'
  | 'DISCONTINUED'
  | 'DISCHARGED'
  | 'COMPLETED'
  | 'ENTERED_IN_ERROR';

/**
 * CER-005. Refuses what is not a form 117.
 *
 * `DISABILITY_SUPPORT` is form 116 and a qualification process of the MSP;
 * `FITNESS` is not a 117 either. Refusing is better than printing an official
 * form that does not correspond.
 */
export function assertIssuableType(
  type: CertificateType,
): asserts type is IssuableCertificateType {
  if (type !== 'ATTENDANCE' && type !== 'MEDICAL_REST') {
    throw new CertificateTypeNotSupportedError();
  }
}

/** CER-006. Both ends included (instructivo, block C). */
export interface RestPeriod {
  from: ClinicalDate;
  to: ClinicalDate;
}

/**
 * CER-006. The rest period of a certificate, or a refusal naming each field.
 *
 * `MEDICAL_REST` demands both dates with the end on or after the start;
 * `ATTENDANCE` admits none. `medical_certificate_rest_range` guarantees the
 * same a second time in the database.
 *
 * ⚠️ NOTHING ELSE IS REFUSED, AND THAT IS D-075. A rest starting before the
 * attention (retroactive) and one longer than 30 days (the IESS validates 1 to
 * 30) are clinical and legal policy pending a decision, not rules to invent.
 */
export function restPeriodOf(
  type: IssuableCertificateType,
  from: ClinicalDate | null,
  to: ClinicalDate | null,
): RestPeriod | null {
  const problems: { field: RestPeriodField; problem: RestPeriodProblem }[] = [];

  if (type === 'ATTENDANCE') {
    if (from !== null) problems.push({ field: 'restFrom', problem: 'NOT_ALLOWED' }); // prettier-ignore
    if (to !== null) problems.push({ field: 'restTo', problem: 'NOT_ALLOWED' });
    if (problems.length > 0) throw new CertificateRestPeriodInvalidError(problems); // prettier-ignore
    return null;
  }

  if (from === null) problems.push({ field: 'restFrom', problem: 'MISSING' });
  if (to === null) problems.push({ field: 'restTo', problem: 'MISSING' });
  if (from === null || to === null) {
    throw new CertificateRestPeriodInvalidError(problems);
  }

  // `YYYY-MM-DD` compares as text exactly as it compares as a date.
  if (to < from) {
    throw new CertificateRestPeriodInvalidError([
      { field: 'restTo', problem: 'ENDS_BEFORE_START' },
    ]);
  }

  return { from, to };
}

/**
 * CER-003. Whether the attention still admits new clinical content.
 *
 * The same three states as ORD-005, declared here and not imported from
 * `encounter`: `DISCHARGED` admits it because the clinical act ended and the
 * patient is still at the desk — which is exactly when the certificate is
 * asked for.
 */
const ADMITS_CERTIFICATES: Readonly<Record<EncounterStatus, boolean>> = {
  OPEN: true,
  ON_HOLD: true,
  DISCHARGED: true,
  COMPLETED: false,
  DISCONTINUED: false,
  ENTERED_IN_ERROR: false,
};

/** CER-003. The lookup into `ADMITS_CERTIFICATES`. */
export function admitsNewCertificates(status: EncounterStatus): boolean {
  return ADMITS_CERTIFICATES[status];
}

/**
 * CER-013. How many days after the end of the rest the IESS still validates
 * the certificate (`ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md` §1.5, REQ-072).
 */
export const IESS_VALIDATION_DAYS = 8;

/**
 * CER-013, REQ-073. Given ALWAYS on a rest certificate: the chart does not
 * keep the type of affiliation, so nobody can tell who it does not apply to.
 */
export const IESS_NOT_APPLICABLE_NOTICE =
  'Este certificado no se valida en el IESS para afiliados voluntarios, jubilados ni afiliados al Seguro Social Campesino';

/** CER-013. What the response of a rest certificate tells the doctor. */
export interface IessValidation {
  /** The last calendar day, in Ecuador, the IESS still validates it. */
  lastValidationDay: ClinicalDate;
  notice: string;
}

/** CER-013. Eight days after `rest_to`, on the calendar: no zone involved. */
export function iessValidationOf(restTo: ClinicalDate): IessValidation {
  return {
    lastValidationDay: addDays(restTo, IESS_VALIDATION_DAYS),
    notice: IESS_NOT_APPLICABLE_NOTICE,
  };
}
