import type { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../domain/clinic-time';
import type {
  DiagnosisCertainty,
  Form117Diagnosis,
  Form117Source,
} from '../../domain/form-117/form-117';

/**
 * CER-020, CER-021. Who the certificate is about: names, chart number and the
 * official documents still in force on the chart. Read at composing time, not
 * copied: it is the person's identity, and what must not move after the issue
 * —diagnoses, work data, sex— is copied.
 */
const FORM_117_IDENTITY_SELECT = {
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  mrn: true,
  identifiers: {
    where: { use: 'OFFICIAL', patientMerged: false },
    select: { type: true, value: true },
  },
} satisfies Prisma.PatientSelect;

/**
 * CER-020 to CER-038. What form 117 is composed from, read ONCE and the same
 * way by the screen (`certificates`) and by the PDF (`documents`).
 *
 * IN `shared` BECAUSE TWO MODULES READ IT and no module imports another. Two
 * selects were already two answers in waiting: the day one of them learnt to
 * read the frozen diagnoses and the other did not, the screen and the paper
 * would have said different things about the same certificate.
 *
 * ⚠️ THE DIAGNOSES, THE WORK DATA AND THE SEX ARE THE CERTIFICATE'S OWN COPY,
 * taken at the issue (CER-027, CER-038, CER-058) — never the attention's or the
 * chart's as they are now. A diagnosis recorded after the issue must not reach
 * a paper the patient authorised without it.
 */
export const FORM_117_SOURCE_SELECT = {
  id: true,
  number: true,
  verificationCode: true,
  type: true,
  issuedAt: true,
  restFrom: true,
  restTo: true,
  includeDiagnosis: true,
  contingencyType: true,
  maternityAdmissionOn: true,
  birthOn: true,
  maternityDischargeOn: true,
  revokedAt: true,
  revocationReason: true,
  diagnoses: true,
  employerName: true,
  jobTitle: true,
  residenceAddressLine: true,
  patientPhone: true,
  // CER-020. The site is the «establecimiento de salud», with its own
  // unicódigo (D-074). CER-036, CER-037: the canton for the place of issue,
  // and the address and phone of the letterhead.
  site: {
    select: {
      name: true,
      mspUnicode: true,
      addressLine: true,
      phone: true,
      parish: { select: { parent: { select: { display: true } } } },
    },
  },
  // CER-058. The sex the paper printed, frozen at the issue with the chart it
  // names (`a_medical_certificate_freeze_chart_of_record`) — never the chart's
  // today, and never another chart's.
  patientSex: true,
  // The attention's chart, for a certificate written before the chart of
  // record existed in a client's types; the database never leaves it null.
  patient: { select: FORM_117_IDENTITY_SELECT },
  /**
   * CER-057 (D-169.2 i). The chart the 117 NAMES: the one in force for the
   * attention at the issue —the survivor if the attention's chart had been
   * merged (D-031 re-points nothing, and the duplicate's document moved to
   * the survivor, PA-043)—. FROZEN as a reference, not re-resolved: merging or
   * undoing afterwards must not put one chart's name over another's sex.
   */
  chartOfRecord: { select: FORM_117_IDENTITY_SELECT },
  encounter: {
    select: {
      startedAt: true,
      endedAt: true,
      // CER-021. The FROZEN age of the attention, never today's.
      ageYears: true,
      ageMonths: true,
      ageDays: true,
    },
  },
  issuedBy: {
    select: {
      // CER-028. Whether there is a seal; the drawn signature is not read.
      sealImageId: true,
      user: { select: { firstName: true, lastName: true, cedula: true } },
      // CER-022. The PRIMARY specialty, if any.
      specialties: {
        where: { isPrimary: true },
        select: { specialty: { select: { name: true } } },
        take: 1,
      },
    },
  },
} satisfies Prisma.MedicalCertificateSelect;

export type Form117SourceRow = Prisma.MedicalCertificateGetPayload<{
  select: typeof FORM_117_SOURCE_SELECT;
}>;

/** A `date` column as the calendar date it is (`YYYY-MM-DD`), no zone. */
function calendarDate(value: Date): ClinicalDate {
  return value.toISOString().slice(0, 10) as ClinicalDate;
}

/** CER-027. The certainties a frozen diagnosis may carry. */
const CERTAINTIES: readonly DiagnosisCertainty[] = [
  'PRESUMPTIVE',
  'DEFINITIVE',
];

/**
 * The frozen copy of the diagnoses, as `issue` wrote it. A copy written before
 * it kept the certainty has none, and stays without: `null`, not a guess.
 */
export function frozenDiagnoses(value: Prisma.JsonValue): Form117Diagnosis[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.code === 'string' &&
    typeof entry.display === 'string'
      ? [
          {
            code: entry.code,
            display: entry.display,
            certainty:
              CERTAINTIES.find((known) => known === entry.certainty) ?? null,
          },
        ]
      : [],
  );
}

/** The row, as `composeForm117` reads it. */
export function toForm117Source(row: Form117SourceRow): Form117Source {
  const maternity =
    row.maternityAdmissionOn === null ||
    row.birthOn === null ||
    row.maternityDischargeOn === null
      ? null
      : {
          admissionOn: calendarDate(row.maternityAdmissionOn),
          birthOn: calendarDate(row.birthOn),
          dischargeOn: calendarDate(row.maternityDischargeOn),
        };
  // CER-057. The chart the certificate names, the same whose sex it froze.
  const chart = row.chartOfRecord ?? row.patient;
  return {
    certificate: {
      id: row.id,
      number: row.number,
      verificationCode: row.verificationCode,
      type: row.type,
      issuedAt: row.issuedAt,
      restFrom: row.restFrom === null ? null : calendarDate(row.restFrom),
      restTo: row.restTo === null ? null : calendarDate(row.restTo),
      includeDiagnosis: row.includeDiagnosis,
      contingencyType: row.contingencyType,
      maternity,
      revokedAt: row.revokedAt,
      revocationReason: row.revocationReason,
    },
    site: {
      name: row.site.name,
      mspUnicode: row.site.mspUnicode,
      city: row.site.parish?.parent?.display ?? null,
      address: row.site.addressLine,
      phone: row.site.phone,
    },
    patient: {
      familyName: chart.familyName,
      secondFamilyName: chart.secondFamilyName,
      givenName: chart.givenName,
      secondGivenName: chart.secondGivenName,
      sex: row.patientSex,
      mrn: chart.mrn,
      employerName: row.employerName,
      jobTitle: row.jobTitle,
      residenceAddressLine: row.residenceAddressLine,
      phone: row.patientPhone,
      identifiers: chart.identifiers,
    },
    encounter: {
      startedAt: row.encounter.startedAt,
      endedAt: row.encounter.endedAt,
      ageYears: row.encounter.ageYears,
      ageMonths: row.encounter.ageMonths,
      ageDays: row.encounter.ageDays,
    },
    diagnoses: frozenDiagnoses(row.diagnoses),
    practitioner: {
      givenNames: row.issuedBy.user.firstName,
      familyNames: row.issuedBy.user.lastName,
      cedula: row.issuedBy.user.cedula,
      primarySpecialty: row.issuedBy.specialties[0]?.specialty.name ?? null,
      hasSeal: row.issuedBy.sealImageId !== null,
    },
  };
}
