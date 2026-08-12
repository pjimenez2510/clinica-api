import { describe, expect, it } from 'vitest';

import { PatientMergedError } from './patient-merged.error';

/**
 * The surviving chart number has to reach the client, and `params` does not:
 * `problem-details.filter.ts` emits `type`, `title`, `status`, `detail`,
 * `code` and `errors[]`, and `detail` is dropped in production. Until this was
 * fixed the number travelled only inside the technical message, so in
 * production the answer was "Esta historia se unificó con otra. Abra la
 * vigente" and no number at all — which is the half of AG-027 that makes the
 * error actionable.
 */
describe('PatientMergedError', () => {
  const error = new PatientMergedError('HC0000000042');

  it('AG-027 carries the surviving chart number in the part that is always emitted', () => {
    expect(error.code).toBe('PATIENT_MERGED');
    expect(error.fieldErrors).toEqual([
      {
        field: 'patientId',
        code: 'PATIENT_MERGED',
        message: 'La historia vigente es HC0000000042',
      },
    ]);
  });

  it('AG-027 says the number and nothing else about the patient', () => {
    // SC-006: no name, no document, no reason for the visit. The MRN is an
    // internal number, and it is the one thing the requirement demands.
    expect(error.userTitle).toBe(
      'Esta historia se unificó con otra. Abra la vigente',
    );
    expect(error.params).toEqual({ mrn: 'HC0000000042' });
  });
});
