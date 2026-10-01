import type { ClinicalDate } from '../clinic-time';

/**
 * The vocabulary of MSP form 117 shared by the two modules that speak it:
 * `certificates`, which issues the certificate and serves its content, and
 * `documents`, which prints it. Pure, and here because no module imports
 * another (CLAUDE.md §3).
 */

/** `CertificateType` of the schema. Declared here, shared by `certificates` and `documents`. */
export type CertificateType =
  'ATTENDANCE' | 'MEDICAL_REST' | 'FITNESS' | 'DISABILITY_SUPPORT';

/**
 * CER-034. The contingency the IESS asks for on a rest certificate. The list
 * comes from the IESS page D-075 cites (2023) and is to be confirmed against
 * its form.
 */
export type ContingencyType =
  'GENERAL_ILLNESS' | 'WORK_ACCIDENT' | 'OCCUPATIONAL_DISEASE' | 'MATERNITY';

export const CONTINGENCY_TYPES: readonly ContingencyType[] = [
  'GENERAL_ILLNESS',
  'WORK_ACCIDENT',
  'OCCUPATIONAL_DISEASE',
  'MATERNITY',
];

/** CER-034. How the form names each contingency. */
export const CONTINGENCY_LABEL: Readonly<Record<ContingencyType, string>> = {
  GENERAL_ILLNESS: 'Enfermedad general',
  WORK_ACCIDENT: 'Accidente de trabajo',
  OCCUPATIONAL_DISEASE: 'Enfermedad profesional',
  MATERNITY: 'Maternidad',
};

/** CER-035. The three dates of a maternity, each a calendar date in Ecuador. */
export interface MaternityDates {
  admissionOn: ClinicalDate;
  birthOn: ClinicalDate;
  dischargeOn: ClinicalDate;
}
