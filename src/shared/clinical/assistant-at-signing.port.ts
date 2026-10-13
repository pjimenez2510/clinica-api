/**
 * AS-140 to AS-144 (E1, D-247 §7). What `encounter` asks the assistant before
 * a signature, and what it tells it after.
 *
 * A SHARED PORT because no module imports another (ADR-011): `encounter`
 * signs, and only `assistant` knows whether it is listening or drafting. The
 * same shape as `CONSULTATION_REPRICER`: `assistant` provides it, `@Global`
 * for this one token.
 */
export interface AssistantActivity {
  /** AS-140. Capturing the consultation now (a paused listening is not). */
  listening: boolean;
  /** AS-141. A draft of the note queued or being written. */
  drafting: boolean;
}

export interface AssistantAtSigning {
  /** AS-140, AS-141. What would keep a note of the attention from being signed. */
  activity(encounterId: string): Promise<AssistantActivity>;
  /**
   * AS-143, AS-144. The consultation note was signed or the attention
   * interrupted, and the signature is already stored: stop the listening,
   * cancel the drafts, review the proposals.
   *
   * ⚠️ NEVER THROWS. A failure here must not turn a signature that already
   * happened into an error on the doctor's screen; it is logged, and what was
   * not reviewed is reviewed at the next sweep.
   */
  signed(encounterId: string): Promise<void>;
}

export const ASSISTANT_AT_SIGNING = Symbol('AssistantAtSigning');
