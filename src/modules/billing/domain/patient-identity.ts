/**
 * BI-183, D-078. Enough to recognise the person at the counter — names, the
 * document and the clinical record number — and nothing clinical.
 *
 * READ AS A PROJECTION, NOT THROUGH THE CHART. Opening the chart records an
 * access (REQ-111); a listing that did it once per row would bury the accesses
 * that matter (BI-133). Identity is not clinical data, so it travels here.
 */
export interface PatientIdentity {
  id: string;
  mrn: string;
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
  /** The chart's first definitive document in force; `null` for a newborn. */
  document: { type: string; value: string } | null;
}
