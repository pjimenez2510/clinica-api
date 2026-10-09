/**
 * EN-094, EN-095. Block J of the RDACAA form, columns 75 to 82: the HIV test.
 *
 * ⚠️ RESTRICTED DATA (REQ-115). It has the door of the violence screening and
 * no other: `hiv-test.repository.ts` is the only port that reads
 * `encounter_hiv_test`, and nothing here may travel in a listing, an error or
 * a log.
 */

/** Column 75, in the form's order: 1 embarazada … 12 pareja de embarazada. */
export const HIV_TEST_REASONS = [
  'PREGNANT',
  'BLOOD_DONATION',
  'VOLUNTARY',
  'TUBERCULOSIS',
  'STI',
  'CLINICAL_SUSPICION',
  'OCCUPATIONAL_EXPOSURE',
  'DEPRIVED_OF_LIBERTY',
  'SEXUAL_VIOLENCE',
  'CAMPAIGN',
  'COMMUNITY_OUTREACH',
  'PARTNER_OF_PREGNANT',
] as const;
export type HivTestReason = (typeof HIV_TEST_REASONS)[number];

/** Columns 76 and 78, «dispositivos médicos empleados en VIH». */
export const HIV_TEST_DEVICES = [
  'RAPID_THIRD_GENERATION',
  'RAPID_FOURTH_GENERATION',
  'ELISA',
  'CLIA',
  'VIRAL_LOAD',
  'IMMUNOFLUORESCENCE',
  'NAT',
] as const;
export type HivTestDevice = (typeof HIV_TEST_DEVICES)[number];

/** Columns 77 and 79. */
export const HIV_TEST_RESULTS = ['REACTIVE', 'NON_REACTIVE'] as const;
export type HivTestResult = (typeof HIV_TEST_RESULTS)[number];

/** Column 80. */
export const HIV_TRANSMISSION_ROUTES = [
  'SEXUAL',
  'BLOOD_OR_TRANSPLANT',
  'INJECTED_DRUGS',
  'MOTHER_TO_CHILD',
] as const;
export type HivTransmissionRoute = (typeof HIV_TRANSMISSION_ROUTES)[number];

export interface HivTestAnswer {
  reason: HivTestReason;
  screening: { device: HivTestDevice; result: HivTestResult };
  /** Only after a reactive screening (`encounter_hiv_test_confirmation_needs_reactive`). */
  confirmation: { device: HivTestDevice; result: HivTestResult } | null;
  transmissionRoute: HivTransmissionRoute | null;
  /** Columns 81 and 82: copies/mL and cells/mm³. */
  viralLoad: number | null;
  cd4: number | null;
}

export interface HivTestRecord extends HivTestAnswer {
  recordedAt: Date;
  editedAt: Date | null;
}

/**
 * EN-094. «Si el resultado de la primera prueba es reactiva, el usuario debe
 * realizarse una segunda prueba de confirmación»: the confirmation and the
 * transmission route exist only after a reactive screening. The database says
 * the same.
 */
export function confirmationAllowed(answer: HivTestAnswer): boolean {
  return (
    answer.screening.result === 'REACTIVE' ||
    (answer.confirmation === null && answer.transmissionRoute === null)
  );
}

export function sameHivTest(a: HivTestAnswer, b: HivTestAnswer): boolean {
  return (
    a.reason === b.reason &&
    a.screening.device === b.screening.device &&
    a.screening.result === b.screening.result &&
    a.confirmation?.device === b.confirmation?.device &&
    a.confirmation?.result === b.confirmation?.result &&
    a.transmissionRoute === b.transmissionRoute &&
    a.viralLoad === b.viralLoad &&
    a.cd4 === b.cd4
  );
}
