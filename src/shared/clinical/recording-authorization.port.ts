/**
 * AS-164 to AS-168 (D-221 §3, D-254 §3). The patient's authorization to
 * record the consultation for the assistant.
 *
 * It is one of `privacy`'s optional authorizations (`ASSISTANT_RECORDING`,
 * PD-068); the listening reads it, and the attention's own professional
 * records it, through here — no module imports another.
 *
 * ⚠️ OF THE PERSON, NOT OF THE ROW: an attention opened on a chart that was
 * merged later is the same patient, so a standing authorization on any of her
 * charts counts (PD-071 keeps one standing per person).
 */
export const RECORDING_AUTHORIZATION = Symbol('RECORDING_AUTHORIZATION');

/** Who records it, as the trail keeps it (PD-069, PD-074). */
export interface RecordingAuthorizationRecorder {
  userId: string;
  ip?: string;
  userAgent?: string;
}

export interface RecordingAuthorization {
  /** AS-165, AS-167. Whether the person has it standing. */
  isAuthorized(patientId: string): Promise<boolean>;
  /**
   * AS-168. Records it on the surviving chart, with its instant, its author
   * and a `CREATE` in the trail; nothing when one is already standing.
   */
  grant(
    patientId: string,
    by: RecordingAuthorizationRecorder,
    now: Date,
  ): Promise<void>;
}
