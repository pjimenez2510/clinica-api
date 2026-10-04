import type { Prisma } from '@prisma/client';

import type { PatientIdentity } from '../domain/patient-identity';

/**
 * BI-183, D-078. The identity caja shows beside an account or a visit.
 *
 * THE DOCUMENT IS THE CHART'S, CHOSEN THE WAY THE CHART CHOOSES IT: the first
 * identifier in force (`valid_to IS NULL`) that is not the `PROVISIONAL`
 * marker of a newborn, oldest first — the `SUMMARY_SELECT` rule of the patients
 * module, repeated here because no module imports another. A newborn without
 * a document answers `null`, and the screen shows the HC alone.
 */
const IDENTITY_FIELDS = {
  id: true,
  mrn: true,
  familyName: true,
  secondFamilyName: true,
  givenName: true,
  secondGivenName: true,
  identifiers: {
    where: { validTo: null, type: { not: 'PROVISIONAL' } },
    select: { type: true, value: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
} satisfies Prisma.PatientSelect;

/**
 * The chart and, when it was merged into another, the surviving one. An
 * account keeps the `patient_id` it was opened on (PA-055), and caja must
 * recognise the person by the record that is still alive — one hop, because
 * `trg_patient_merge_not_chained` forbids chains (PA-046).
 */
export const PATIENT_IDENTITY_SELECT = {
  ...IDENTITY_FIELDS,
  mergedInto: { select: IDENTITY_FIELDS },
} satisfies Prisma.PatientSelect;

type IdentityRow = Prisma.PatientGetPayload<{ select: typeof IDENTITY_FIELDS }>;
type IdentityRowWithMerge = Prisma.PatientGetPayload<{
  select: typeof PATIENT_IDENTITY_SELECT;
}>;

export function toPatientIdentity(row: IdentityRowWithMerge): PatientIdentity {
  const chart: IdentityRow = row.mergedInto ?? row;
  const document = chart.identifiers[0];
  return {
    id: chart.id,
    mrn: chart.mrn,
    familyName: chart.familyName,
    secondFamilyName: chart.secondFamilyName,
    givenName: chart.givenName,
    secondGivenName: chart.secondGivenName,
    document: document ? { type: document.type, value: document.value } : null,
  };
}
