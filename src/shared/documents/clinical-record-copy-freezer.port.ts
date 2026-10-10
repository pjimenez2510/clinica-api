import type { RecordReadScope } from '../domain/clinical-record-key';

/**
 * DOC-122 (D-203 §3; revisión clínica del 10-10-2026). What a copy of the
 * clinical record carries is FROZEN when an answer authorises it: every
 * download serves what was authorised, and a diagnosis added, a note amended
 * or a screening corrected afterwards does not change what was handed over
 * —nor reaches a third party without the review it would have needed—.
 *
 * A SHARED PORT because no module imports another: `privacy` authorises (the
 * answer is the authorisation, EN-033) and saves the frozen data with the
 * answer, in one transaction; `documents` knows what the copy carries and
 * paints it. The data is opaque to `privacy`.
 */
export interface FreezeCopyInput {
  requestId: string;
  /** The `record:read` scope of whoever authorises: what the copy reaches. */
  recordScope: RecordReadScope;
  /** The instant of the answer: what the copy carries is what stood then. */
  authorisedAt: Date;
  authorisedById: string;
  /** PD-059. The period of «Atendida en parte»; `null`, the whole record. */
  copyPeriod: { from: string; to: string } | null;
}

export interface ClinicalRecordCopyFreezer {
  /**
   * The print data of the copy as it stands now, JSON-serialisable; `null`
   * when the caller holds no key to the person's record (refused upstream).
   */
  freeze(input: FreezeCopyInput): Promise<unknown>;
}

export const CLINICAL_RECORD_COPY_FREEZER = Symbol('ClinicalRecordCopyFreezer');
