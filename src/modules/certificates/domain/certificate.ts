import {
  addDays,
  addMonths,
  clinicalDateOf,
  clinicalDaySpan,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  CertificateBackdatingReasonRequiredError,
  CertificateIssuerReasonRequiredError,
  CertificateMaternityBirthMismatchError,
  CertificateMaternityBirthTooFarError,
  CertificateMaternityDatesTooOldError,
  CertificateMaternityDiagnosisRequiredError,
  CertificateMaternityLeaveExceededError,
  CertificateRestOverlapsError,
  CertificateRestIssuedTooLateError,
  CertificateRestPeriodInvalidError,
  CertificateRestStartTooEarlyError,
  CertificateRestStartTooLateError,
  CertificateRestTooLongError,
  CertificateTypeNotSupportedError,
  type PatientWorkField,
  type RestPeriodField,
  type RestPeriodProblem,
} from './certificate.errors';
export {
  CONTINGENCY_LABEL,
  CONTINGENCY_TYPES,
  type CertificateType,
  type ContingencyType,
  type MaternityDates,
} from '../../../shared/domain/form-117/vocabulary';
import type {
  CertificateType,
  ContingencyType,
  MaternityDates,
} from '../../../shared/domain/form-117/vocabulary';

/**
 * The medical certificate of form SNS-MSP/HCU-form.117/2021: its types, its
 * rest period, the attentions that admit one, and what the IESS needs to know.
 *
 * PURE: no clock, no storage. Dates arrive as `ClinicalDate` — calendar dates
 * in Ecuador — because `rest_from` and `rest_to` are `date` columns, not
 * instants.
 */

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

/** CER-006, CER-007, CER-034, CER-035. What the request says about the rest. */
export interface RestRequest {
  restFrom: ClinicalDate | null;
  restTo: ClinicalDate | null;
  contingencyType: ContingencyType | null;
  maternityAdmissionOn: ClinicalDate | null;
  birthOn: ClinicalDate | null;
  maternityDischargeOn: ClinicalDate | null;
  includeDiagnosis: boolean;
}

/** The rest, once every rule that needs no storage has accepted it. */
export interface RestDetails {
  period: RestPeriod;
  /** CER-026, CER-031. Calendar days, both ends included. */
  days: number;
  contingencyType: ContingencyType;
  /** CER-035. Present exactly with `MATERNITY`. */
  maternity: MaternityDates | null;
}

/** CER-038. What the chart says about the patient's work and contact. */
export interface PatientWork {
  employerName: string | null;
  jobTitle: string | null;
  residenceAddressLine: string | null;
  phone: string | null;
}

/** CER-038. How the notice names each field to the doctor. */
const PATIENT_WORK_LABEL: Readonly<Record<PatientWorkField, string>> = {
  employerName: 'la empresa',
  jobTitle: 'el puesto de trabajo',
  residenceAddressLine: 'el domicilio',
  phone: 'el teléfono',
};

/** CER-038. The fields a rest prints and the chart lacks; blank is missing. */
export function missingPatientWork(work: PatientWork): PatientWorkField[] {
  const fields: PatientWorkField[] = [
    'employerName',
    'jobTitle',
    'residenceAddressLine',
    'phone',
  ];
  return fields.filter((field) => {
    const value = work[field];
    return value === null || value.trim() === '';
  });
}

/**
 * CER-038, D-101. The rest IS issued without them —the author decided it—, and
 * the doctor is told which ones are missing and what it may cost. `null` when
 * nothing is missing. Fields are named, values never (CER-014).
 */
export function patientWorkNotice(
  missing: readonly PatientWorkField[],
): string | null {
  if (missing.length === 0) return null;
  const names = missing.map((field) => PATIENT_WORK_LABEL[field]);
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `Falta en la ficha ${listed} del paciente. El IESS puede devolver el reposo sin estos datos; complételos en la ficha.`;
}

/** CER-031. The IESS validates rests of one to thirty days. */
export const MAX_REST_DAYS = 30;

type Problem = { field: RestPeriodField; problem: RestPeriodProblem };

/**
 * CER-006, CER-007, CER-031, CER-034, CER-035. The rest of a certificate, or a
 * refusal naming every field at once.
 *
 * `ATTENDANCE` admits nothing of the rest. `MEDICAL_REST` demands both dates
 * in order, the diagnosis always (CER-007: the IESS does not validate a rest
 * without its CIE-10), the contingency, and — with `MATERNITY` and only then —
 * the dates of admission, birth and discharge. More than 30 days is its own
 * refusal (CER-031). The backdating (CER-030) needs the attention's date and
 * is judged apart, in `backdatingReasonOf`.
 */
export function restDetailsOf(
  type: IssuableCertificateType,
  request: RestRequest,
): RestDetails | null {
  const problems: Problem[] = [];
  const maternityFields = [
    ['maternityAdmissionOn', request.maternityAdmissionOn],
    ['birthOn', request.birthOn],
    ['maternityDischargeOn', request.maternityDischargeOn],
  ] as const;

  if (type === 'ATTENDANCE') {
    const present: (readonly [RestPeriodField, unknown])[] = [
      ['restFrom', request.restFrom],
      ['restTo', request.restTo],
      ['contingencyType', request.contingencyType],
      ...maternityFields,
    ];
    for (const [field, value] of present) {
      if (value !== null) problems.push({ field, problem: 'NOT_ALLOWED' });
    }
    if (problems.length > 0) throw new CertificateRestPeriodInvalidError(problems); // prettier-ignore
    return null;
  }

  const { restFrom: from, restTo: to, contingencyType } = request;
  if (from === null) problems.push({ field: 'restFrom', problem: 'MISSING' });
  if (to === null) problems.push({ field: 'restTo', problem: 'MISSING' });
  if (!request.includeDiagnosis) {
    problems.push({ field: 'includeDiagnosis', problem: 'MUST_BE_INCLUDED' });
  }
  if (contingencyType === null) {
    problems.push({ field: 'contingencyType', problem: 'MISSING' });
  }
  const isMaternity = contingencyType === 'MATERNITY';
  for (const [field, value] of maternityFields) {
    if (isMaternity && value === null) problems.push({ field, problem: 'MISSING' }); // prettier-ignore
    if (!isMaternity && value !== null) problems.push({ field, problem: 'NOT_ALLOWED' }); // prettier-ignore
  }
  // CER-035. Admission, birth and discharge, in that order: the IESS returns
  // a maternity whose dates contradict each other.
  const { maternityAdmissionOn: admission, birthOn: birth, maternityDischargeOn: discharge } = request; // prettier-ignore
  if (
    isMaternity &&
    admission !== null &&
    birth !== null &&
    birth < admission
  ) {
    problems.push({ field: 'birthOn', problem: 'OUT_OF_ORDER' });
  }
  if (
    isMaternity &&
    birth !== null &&
    discharge !== null &&
    discharge < birth
  ) {
    problems.push({ field: 'maternityDischargeOn', problem: 'OUT_OF_ORDER' });
  }
  if (from !== null && to !== null && to < from) {
    // `YYYY-MM-DD` compares as text exactly as it compares as a date.
    problems.push({ field: 'restTo', problem: 'ENDS_BEFORE_START' });
  }
  if (problems.length > 0 || from === null || to === null || contingencyType === null) {
    throw new CertificateRestPeriodInvalidError(problems);
  } // prettier-ignore

  const days = clinicalDaySpan(from, to);
  if (days > MAX_REST_DAYS) throw new CertificateRestTooLongError();

  return {
    period: { from, to },
    days,
    contingencyType,
    maternity: isMaternity
      ? {
          admissionOn: request.maternityAdmissionOn as ClinicalDate,
          birthOn: request.birthOn as ClinicalDate,
          dischargeOn: request.maternityDischargeOn as ClinicalDate,
        }
      : null,
  };
}

/** CER-030, CER-039. The shortest reason that says something. */
export const MIN_BACKDATING_REASON_LENGTH = 10;

/**
 * CER-030. The reason of a rest that starts before the clinical date of the
 * attention, or is issued on a later day (D-105 §3), trimmed, or a refusal
 * without it. Every date is a calendar date in `America/Guayaquil`.
 *
 * A rest issued on the day of the attention and starting no earlier keeps NO
 * reason: a reason stored on a rest that needed none would read as a backdated
 * certificate that was not. `medical_certificate_issue_rules` says the same in
 * the database.
 */
export function backdatingReasonOf(
  period: RestPeriod,
  attentionDate: ClinicalDate,
  issueDate: ClinicalDate,
  reason: string | null,
): string | null {
  const backdated = period.from < attentionDate;
  const late = issueDate > attentionDate;
  if (!backdated && !late) return null;
  const written = reason?.trim() ?? '';
  if (written.length < MIN_BACKDATING_REASON_LENGTH) {
    throw new CertificateBackdatingReasonRequiredError(
      backdated ? 'BACKDATED' : 'LATE',
    );
  }
  return written;
}

/**
 * CER-041. The latest day a rest may start: the day after it is issued. The
 * doctor who attends at night gives the rest from tomorrow; a rest that starts
 * in three months is not a rest of this attention (D-105 §3).
 */
export function latestRestStartOf(issueDate: ClinicalDate): ClinicalDate {
  return addDays(issueDate, 1);
}

/**
 * CER-030, D-106 §5. The day an issue counts as, to judge whether it is late:
 * Ecuador's calendar day, with the dawn —until 06:00— counted as the day
 * before. A doctor who signs at 02:00 the rest of a night attention is not
 * issuing late. Ecuador has no daylight saving: six hours are six hours.
 */
export const DAWN_HOURS = 6;
export function lateIssueDayOf(issuedAt: Date): ClinicalDate {
  return clinicalDateOf(new Date(issuedAt.getTime() - DAWN_HOURS * 60 * 60 * 1000)); // prettier-ignore
}

/** CER-044, D-106 §1. How many days before the attention a rest may start. */
export const MAX_REST_DAYS_BEFORE_ATTENTION = 3;

/** CER-045, D-106 §4. How many days after the attention a rest is issued. */
export const MAX_DAYS_TO_ISSUE_REST = 8;

/**
 * CER-044, CER-045. The window of a rest around its attention: it starts at
 * most three days before, and it is issued at most eight days after (with the
 * dawn of CER-030). The reason of CER-030 does not widen either bound.
 *
 * D-108. A maternity rest may also start ON the day of admission or of birth,
 * however long ago, and has no eight-day limit: the mother who gave birth in a
 * hospital comes days later, and the leave chains certificates (CER-043). Any
 * other day still keeps the three days, so a prenatal rest is as it was
 * (D-106 §2). What bounds those dates is D-109, pending.
 */
export function assertRestWithinAttention(
  period: RestPeriod,
  attentionDate: ClinicalDate,
  lateIssueDay: ClinicalDate,
  maternity: MaternityDates | null,
): void {
  const earliest = addDays(attentionDate, -MAX_REST_DAYS_BEFORE_ATTENTION);
  const onMaternityDay =
    maternity !== null &&
    (period.from === maternity.admissionOn ||
      period.from === maternity.birthOn);
  if (period.from < earliest && !onMaternityDay) {
    // Its days are named only when one of them is before the bound: a prenatal
    // rest is offered no future day that CER-041 would refuse next.
    const namesItsDays =
      maternity !== null &&
      (maternity.admissionOn < earliest || maternity.birthOn < earliest);
    throw new CertificateRestStartTooEarlyError(earliest, namesItsDays ? maternity : null); // prettier-ignore
  }
  if (maternity !== null) return;
  if (lateIssueDay > addDays(attentionDate, MAX_DAYS_TO_ISSUE_REST)) {
    throw new CertificateRestIssuedTooLateError();
  }
}

/**
 * CER-046, D-109, D-110 §3. How many days before the attention the birth may
 * be: twelve weeks.
 */
export const MATERNITY_LEAVE_DAYS = 84;

/** CER-046, D-110 §1. How many days after the attention the birth may be. */
export const MAX_BIRTH_DAYS_AFTER_ATTENTION = 28;

/** CER-050, D-110 §2. Two births closer than this are one pregnancy. */
export const MONTHS_BETWEEN_PREGNANCIES = 9;

/**
 * CER-049. An obstetric CIE-10: O00 to O99 or Z34 to Z39, with their
 * subcategories, as the catalogue writes them (`O80`, `Z390`). A chapter
 * range (`O00-O9A`) or the US-only `O9A` is not one.
 */
export function isObstetricCie10(code: string): boolean {
  return /^(O[0-9]{2}|Z3[4-9])[0-9A-Z]*$/.test(code);
}

/**
 * CER-048. Another rest of the patient's chart, not revoked; `maternityBirthOn`
 * is its birth when it is a maternity rest, `null` otherwise.
 */
export interface PatientRest extends RestPeriod {
  maternityBirthOn: ClinicalDate | null;
}

/** CER-048. Both ends included: a rest that ends the day another starts overlaps. */
const overlaps = (period: RestPeriod) => (other: RestPeriod) =>
  other.from <= period.to && period.from <= other.to;

/**
 * CER-046 to CER-050, D-109, D-110 (provisional until the IESS confirms the
 * procedure, D-105 §6). What bounds a maternity rest once D-108 took the three
 * and eight days away:
 *
 * - its birth at most 84 days before the attention and 28 after it (the
 *   admission does not count);
 * - the rest within the leave, twelve weeks counting the birth's day (last day
 *   birth + 83), and issued before it ends (with the dawn of CER-030);
 * - an obstetric diagnosis on the attention;
 * - the same birth as any other maternity rest of the patient within nine
 *   months — one pregnancy, one birth;
 * - no other rest of the patient, not revoked, over the same days.
 */
export function assertMaternityWithinLeave(
  period: RestPeriod,
  maternity: MaternityDates,
  attentionDate: ClinicalDate,
  lateIssueDay: ClinicalDate,
  diagnosisCodes: readonly string[],
  otherRests: readonly PatientRest[],
): void {
  const birth = maternity.birthOn;
  const earliest = addDays(attentionDate, -MATERNITY_LEAVE_DAYS);
  if (birth < earliest)
    throw new CertificateMaternityDatesTooOldError(earliest);
  const latest = addDays(attentionDate, MAX_BIRTH_DAYS_AFTER_ATTENTION);
  if (birth > latest) throw new CertificateMaternityBirthTooFarError(latest);
  const lastDay = addDays(birth, MATERNITY_LEAVE_DAYS - 1);
  if (period.to > lastDay || lateIssueDay > lastDay) {
    throw new CertificateMaternityLeaveExceededError(lastDay);
  }
  if (!diagnosisCodes.some(isObstetricCie10)) {
    throw new CertificateMaternityDiagnosisRequiredError();
  }
  const from = addMonths(birth, -MONTHS_BETWEEN_PREGNANCIES);
  const to = addMonths(birth, MONTHS_BETWEEN_PREGNANCIES);
  const other = otherRests.find(
    ({ maternityBirthOn: b }) =>
      b !== null && b !== birth && b >= from && b <= to,
  );
  if (other?.maternityBirthOn) {
    throw new CertificateMaternityBirthMismatchError(other.maternityBirthOn);
  }
  if (otherRests.some(overlaps(period)))
    throw new CertificateRestOverlapsError();
}

/**
 * CER-048, D-110 §5. A rest of another contingency over a maternity rest of
 * the patient that is not revoked. Two rests of other contingencies may still
 * overlap: nobody decided otherwise.
 */
export function assertRestDoesNotOverlapMaternity(
  period: RestPeriod,
  otherRests: readonly PatientRest[],
): void {
  const maternities = otherRests.filter(
    (rest) => rest.maternityBirthOn !== null,
  );
  if (maternities.some(overlaps(period)))
    throw new CertificateRestOverlapsError();
}

/** CER-041. Refuses a rest that starts after `latestRestStartOf`. */
export function assertRestStartsInTime(
  period: RestPeriod,
  issueDate: ClinicalDate,
): void {
  const latest = latestRestStartOf(issueDate);
  if (period.from > latest) throw new CertificateRestStartTooLateError(latest);
}

/**
 * CER-039. Why someone other than the practitioner of the attention issues
 * its certificate, trimmed, or a refusal without it (D-105 §1).
 *
 * The attending practitioner keeps NO reason, whatever the request carried: a
 * third-party reason on their own certificate would say they did not attend.
 */
export function issuerReasonOf(
  issuerId: string,
  attendingId: string,
  reason: string | null,
): string | null {
  if (issuerId === attendingId) return null;
  const written = reason?.trim() ?? '';
  if (written.length < MIN_BACKDATING_REASON_LENGTH) {
    throw new CertificateIssuerReasonRequiredError();
  }
  return written;
}

/**
 * CER-032. The specialty code of general medicine, as `seed-specialties.mts`
 * ships it.
 */
export const GENERAL_MEDICINE_SPECIALTY_CODE = 'medicina-general';

/**
 * CER-032. From how many days a rest is long enough to warn about: three for
 * general medicine and for a practitioner with no specialty, seven for any
 * other specialty (decided by the principal session, 01-10-2026).
 */
export function restNoticeThresholdOf(
  primarySpecialtyCode: string | null,
): number {
  return primarySpecialtyCode === null ||
    primarySpecialtyCode === GENERAL_MEDICINE_SPECIALTY_CODE
    ? 3
    : 7;
}

/** CER-032. The notice, with the number of days in it. */
export function longRestNotice(days: number): string {
  return `Este reposo es de ${days} días. El IESS puede pedir una cita de control o una justificación para validar reposos largos; compruebe que el paciente pueda validarlo.`;
}

/**
 * CER-043, D-105 §6. Maternity leave is twelve weeks and a certificate covers
 * thirty days at most (CER-031), so it chains three or more; whether the IESS
 * takes it on this form at all is what the doctor confirms first.
 */
export const MATERNITY_CHAIN_NOTICE =
  'La licencia de maternidad dura doce semanas y cada certificado cubre como mucho 30 días. Antes de emitir los siguientes, confirme con el IESS si la maternidad se certifica en este formulario o por otro trámite.';

/**
 * CER-032, CER-043. One notice when the rest exceeds the issuer's threshold,
 * and one on every maternity rest. They never refuse the issue.
 */
export function restNoticesOf(
  days: number,
  primarySpecialtyCode: string | null,
  contingencyType: ContingencyType,
): string[] {
  const notices =
    days > restNoticeThresholdOf(primarySpecialtyCode)
      ? [longRestNotice(days)]
      : [];
  if (contingencyType === 'MATERNITY') notices.push(MATERNITY_CHAIN_NOTICE);
  return notices;
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
  'Este certificado no se valida en el IESS para afiliados voluntarios, menores de edad, jubilados ni afiliados al Seguro Social Campesino';

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
