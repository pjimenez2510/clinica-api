import {
  clinicalDateOf,
  clinicalDaySpan,
  wallClockOf,
  type ClinicalDate,
} from '../clinic-time';
import { spellQuantity } from '../quantity-in-words';

import {
  CONTINGENCY_LABEL,
  type CertificateType,
  type ContingencyType,
  type MaternityDates,
} from './vocabulary';
import {
  dateInNumbersAndWords,
  type DateInNumbersAndWords,
} from './date-in-words';

/**
 * CER-020 to CER-029. The content of form SNS-MSP/HCU-form.117/2021, in its
 * five blocks, composed from what storage answers.
 *
 * PURE: every instant arrives as a parameter and is resolved in
 * `America/Guayaquil` by `clinic-time`, never in the host's zone.
 *
 * ⚠️ WHAT IS PRINTED IN LETTERS IS DERIVED FROM THE FIGURE AND NEVER TYPED
 * (the argument of PR-030). And where the instructivo says «En caso de que
 * existan variables que no pueden ser llenadas, se colocará NA», this serves
 * «NA» rather than an empty string: an empty box on an official form is a box
 * somebody can fill in afterwards.
 */

/** «NA = no aplica», as the instructivo writes it. */
export const NA = 'NA' as const;
export type NotApplicable = typeof NA;

/** `PatientSex` of the schema, declared here: no module imports another. */
export type PatientSex = 'MALE' | 'FEMALE' | 'INTERSEX' | 'UNKNOWN';

/**
 * `DiagnosisCertainty` of the schema, declared here for the same reason: the
 * 117's PRE and DEF columns (CER-027).
 */
export type DiagnosisCertainty = 'PRESUMPTIVE' | 'DEFINITIVE';

/**
 * CER-027. One diagnosis of block D. `certainty` is `null` on a certificate
 * issued before the copy kept it: printed with neither column marked, never
 * deduced from the attention as it is now.
 */
export interface Form117Diagnosis {
  code: string;
  display: string;
  certainty: DiagnosisCertainty | null;
}

/** `IdentifierType` of the schema, declared here for the same reason. */
export type IdentifierType =
  'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL';

/** Everything form 117 prints, as storage answers it. */
export interface Form117Source {
  certificate: {
    id: string;
    number: number;
    verificationCode: string;
    type: CertificateType;
    issuedAt: Date;
    restFrom: ClinicalDate | null;
    restTo: ClinicalDate | null;
    includeDiagnosis: boolean;
    /** CER-034. `null` on an attendance certificate. */
    contingencyType: ContingencyType | null;
    /** CER-035. Present exactly with `MATERNITY`. */
    maternity: MaternityDates | null;
    revokedAt: Date | null;
    revocationReason: string | null;
  };
  /** The site is the «establecimiento de salud», with its own unicódigo. */
  site: {
    name: string;
    mspUnicode: string;
    /** CER-036. The canton of the site's parish; `null` without a parish. */
    city: string | null;
    /** CER-037. For the letterhead. */
    address: string | null;
    phone: string | null;
  };
  patient: {
    familyName: string;
    secondFamilyName: string | null;
    givenName: string;
    secondGivenName: string | null;
    sex: PatientSex;
    /** The archive number of the establishment. */
    mrn: string;
    /** CER-038. Read from the chart (PA-061); printed only on a rest. */
    employerName: string | null;
    jobTitle: string | null;
    residenceAddressLine: string | null;
    phone: string | null;
    /** The patient's official identity documents, in any order. */
    identifiers: readonly { type: IdentifierType; value: string }[];
  };
  encounter: {
    startedAt: Date;
    endedAt: Date | null;
    /** The FROZEN age of the attention (`trg_encounter_freeze_age`). */
    ageYears: number | null;
    ageMonths: number | null;
    ageDays: number | null;
  };
  /** The diagnoses of the attention, principal first. */
  diagnoses: readonly Form117Diagnosis[];
  practitioner: {
    givenNames: string;
    familyNames: string;
    cedula: string | null;
    /** The name of the practitioner's PRIMARY specialty, if any. */
    primarySpecialty: string | null;
    hasSeal: boolean;
  };
}

/** CER-021. «Condición edad»: horas, días, meses o años. */
export type AgeCondition = 'H' | 'D' | 'M' | 'A';

/** CER-020 to CER-029. The form, block by block. */
export interface Form117 {
  id: string;
  /** CER-029. */
  number: number;
  verificationCode: string;
  type: CertificateType;
  /** CER-029. `null` while the certificate is valid. */
  revocation: {
    revokedAt: Date;
    /** The Ecuadorian calendar date of the annulment. */
    revokedOn: ClinicalDate;
    reason: string;
  } | null;
  /**
   * CER-038. The patient's employer, job title, address and phone, on a rest;
   * «NA» on attendance. A datum the chart lost after the issue reads «NA».
   */
  work:
    | { employer: string; jobTitle: string; address: string; phone: string }
    | NotApplicable;
  /** CER-033. «CONFIDENCIAL» exactly when the diagnosis is printed. */
  confidential: boolean;
  /** CER-036. The city of issue: the canton of the site's parish, or «NA». */
  placeOfIssue: string;
  /**
   * CER-037. For the letterhead: the site's address and phone. The
   * establishment has no address, phone or email in the schema, so there is
   * no fallback to it, and `email` is always `null` (⚠️ falta esquema).
   */
  letterhead: {
    address: string | null;
    phone: string | null;
    email: null;
  };
  /** CER-034. The contingency in Spanish, or «NA» on attendance. */
  contingency: string;
  /** CER-035. Admission, birth and discharge, or «NA» outside maternity. */
  maternity:
    | {
        admission: DateInNumbersAndWords;
        birth: DateInNumbersAndWords;
        discharge: DateInNumbersAndWords;
      }
    | NotApplicable;
  /** CER-020. Block A. */
  establishment: {
    /** MSP, IESS, ISSFFA or ISPOL — a private clinic is none of them. */
    institution: NotApplicable;
    mspUnicode: string;
    name: string;
    /** The patient's identity document, or «NA». */
    clinicalRecordNumber: string;
    /** The patient's `mrn`. */
    archiveNumber: string;
  };
  /** CER-021. Block B, the person. */
  patient: {
    firstFamilyName: string;
    secondFamilyName: string;
    firstGivenName: string;
    secondGivenName: string;
    sex: 'Hombre' | 'Mujer' | NotApplicable;
    age: { value: string; condition: AgeCondition | NotApplicable };
  };
  /** CER-022 to CER-024. Block B, the attention. */
  attention: {
    service: string;
    specialty: string;
    date: DateInNumbersAndWords;
    /** `HH:MM`, 24 hours, in Guayaquil. */
    from: string;
    to: string;
    admissionDate: NotApplicable;
    dischargeDate: NotApplicable;
  };
  /** CER-025, CER-026. Block C, in DAYS and never in hours (D-075). */
  rest: {
    rest: 'SÍ' | 'NO';
    days: string;
    daysInWords: string;
    from: DateInNumbersAndWords | NotApplicable;
    to: DateInNumbersAndWords | NotApplicable;
    /** «desde el … hasta el …, ambas fechas incluidas» (instructivo, block C). */
    periodInWords: string;
  };
  /** CER-027. Block D. */
  diagnoses: readonly Form117Diagnosis[] | NotApplicable;
  /** CER-028. Block E. */
  professional: {
    /** `YYYY-MM-DD` of the issue, in Ecuador. */
    date: ClinicalDate;
    /** `HH:MM` of the issue, 24 hours, in Ecuador. */
    time: string;
    givenNames: string;
    familyNames: string;
    identification: string;
    hasSeal: boolean;
    /** There is no drawn signature, and there never will be (as PR-035). */
    signature: 'CREDENTIAL';
  };
}

/** CER-022. The clinic is ambulatory (supuesto 1). */
const SERVICE = 'Consulta externa';

/**
 * CER-020. Which document is «el número de historia clínica única»: the
 * cédula, and for foreigners the passport or the refugee card; failing all,
 * the temporary code issued by statistics.
 */
const DOCUMENT_PRIORITY: readonly IdentifierType[] = [
  'CEDULA',
  'PASSPORT',
  'REFUGEE_CARD',
  'FOREIGN_ID',
  'PROVISIONAL',
];

/** CER-020 to CER-029. Composes the five blocks of form 117. */
export function composeForm117(source: Form117Source): Form117 {
  const { certificate, patient, encounter, practitioner } = source;
  const diagnoses =
    certificate.includeDiagnosis && source.diagnoses.length > 0
      ? source.diagnoses.map(({ code, display, certainty }) => ({
          code,
          display,
          certainty,
        }))
      : NA;

  return {
    id: certificate.id,
    number: certificate.number,
    verificationCode: certificate.verificationCode,
    type: certificate.type,
    revocation:
      certificate.revokedAt === null
        ? null
        : {
            revokedAt: certificate.revokedAt,
            revokedOn: clinicalDateOf(certificate.revokedAt),
            reason: certificate.revocationReason ?? '',
          },
    work:
      certificate.type === 'MEDICAL_REST'
        ? {
            employer: filledOrNa(patient.employerName),
            jobTitle: filledOrNa(patient.jobTitle),
            address: filledOrNa(patient.residenceAddressLine),
            phone: filledOrNa(patient.phone),
          }
        : NA,
    confidential: diagnoses !== NA,
    placeOfIssue: source.site.city ?? NA,
    letterhead: {
      address: source.site.address,
      phone: source.site.phone,
      email: null,
    },
    contingency:
      certificate.contingencyType === null
        ? NA
        : CONTINGENCY_LABEL[certificate.contingencyType],
    maternity:
      certificate.maternity === null
        ? NA
        : {
            admission: dateInNumbersAndWords(certificate.maternity.admissionOn),
            birth: dateInNumbersAndWords(certificate.maternity.birthOn),
            discharge: dateInNumbersAndWords(certificate.maternity.dischargeOn),
          },
    establishment: {
      institution: NA,
      mspUnicode: source.site.mspUnicode,
      name: source.site.name,
      clinicalRecordNumber: identityDocumentOf(patient.identifiers),
      archiveNumber: patient.mrn,
    },
    patient: {
      firstFamilyName: patient.familyName,
      secondFamilyName: patient.secondFamilyName ?? NA,
      firstGivenName: patient.givenName,
      secondGivenName: patient.secondGivenName ?? NA,
      sex: sexOf(patient.sex),
      age: ageOf(encounter),
    },
    attention: {
      service: SERVICE,
      specialty: practitioner.primarySpecialty ?? NA,
      date: dateInNumbersAndWords(clinicalDateOf(encounter.startedAt)),
      from: hourOf(encounter.startedAt),
      to: hourOf(attentionEnd(encounter.endedAt, certificate.issuedAt)),
      admissionDate: NA,
      dischargeDate: NA,
    },
    rest: restOf(certificate.restFrom, certificate.restTo),
    diagnoses,
    professional: {
      date: clinicalDateOf(certificate.issuedAt),
      time: hourOf(certificate.issuedAt),
      givenNames: practitioner.givenNames,
      familyNames: practitioner.familyNames,
      identification: practitioner.cedula ?? NA,
      hasSeal: practitioner.hasSeal,
      signature: 'CREDENTIAL',
    },
  };
}

/** CER-020. The first document by priority, or «NA». */
function identityDocumentOf(
  identifiers: Form117Source['patient']['identifiers'],
): string {
  for (const type of DOCUMENT_PRIORITY) {
    const found = identifiers.find((identifier) => identifier.type === type);
    if (found) return found.value;
  }
  return NA;
}

/**
 * CER-021. «Hombre o Mujer, según manifieste el paciente». `INTERSEX` and
 * `UNKNOWN` are not boxes of the form, and marking one of the two for them
 * would make the document say something nobody declared: «NA».
 */
function sexOf(sex: PatientSex): 'Hombre' | 'Mujer' | NotApplicable {
  if (sex === 'MALE') return 'Hombre';
  if (sex === 'FEMALE') return 'Mujer';
  return NA;
}

/**
 * CER-021. The frozen age with its condition: in years from one year, in
 * months under a year, in days under a month.
 *
 * ⚠️ NEVER «H». Hours would need the hour of birth, and `patient.birth_date`
 * is a date: an age in hours computed from it would be invented.
 */
function ageOf(
  encounter: Form117Source['encounter'],
): Form117['patient']['age'] {
  if (encounter.ageYears === null) return { value: NA, condition: NA };
  if (encounter.ageYears >= 1) {
    return { value: String(encounter.ageYears), condition: 'A' };
  }
  const months = encounter.ageMonths ?? 0;
  if (months >= 1) return { value: String(months), condition: 'M' };
  return { value: String(encounter.ageDays ?? 0), condition: 'D' };
}

/**
 * CER-023. The end of the attention — or the instant of issue if the
 * attention was still open then. Read against the issue and not against
 * today, so the printed hour never changes after the fact.
 */
function attentionEnd(endedAt: Date | null, issuedAt: Date): Date {
  return endedAt !== null && endedAt.getTime() <= issuedAt.getTime()
    ? endedAt
    : issuedAt;
}

/** `HH:MM` in Guayaquil, 24 hours; the seconds are not a box of the form. */
function hourOf(instant: Date): string {
  const time = wallClockOf(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(time.hour)}:${pad(time.minute)}`;
}

/**
 * CER-025, CER-026. «SÍ» or «NO», never blank; with rest, the calendar days of
 * the period — both ends included — in numbers and in words, and both dates
 * in numbers and in words. Never hours: the IESS returns a certificate that
 * expresses the rest in hours (D-075).
 */
function restOf(
  from: ClinicalDate | null,
  to: ClinicalDate | null,
): Form117['rest'] {
  if (from === null || to === null) {
    return {
      rest: 'NO',
      days: NA,
      daysInWords: NA,
      from: NA,
      to: NA,
      periodInWords: NA,
    };
  }
  const days = clinicalDaySpan(from, to);
  const start = dateInNumbersAndWords(from);
  const end = dateInNumbersAndWords(to);
  return {
    rest: 'SÍ',
    days: String(days),
    daysInWords: spellQuantity(days),
    from: start,
    to: end,
    periodInWords: `desde el ${start.inWords} hasta el ${end.inWords}, ambas fechas incluidas`,
  };
}

/** CER-038. A blank box on an official form is one somebody fills in later. */
function filledOrNa(value: string | null): string {
  return value === null || value.trim() === '' ? NA : value;
}
