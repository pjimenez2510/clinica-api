/**
 * AS-121, AS-123. Each review «Para completar la nota» that answered, as
 * `note_question_check` keeps it: no text, never rewritten.
 */
export interface NoteQuestionCheck {
  encounterId: string;
  /** The attempt that answered: the questions of this review cite it. */
  aiRunId: string;
  /** The end of the last segment it read, in the listening's clock. */
  upToMs: number;
  /** SHA-256 in lowercase hex of what the note had written. */
  noteDigest: string;
  asked: number;
  dropped: number;
  requestedBy: string;
  checkedAt: Date;
}

export interface NoteQuestionCheckStore {
  record(check: NoteQuestionCheck): Promise<void>;
  /** AS-122. The latest review of the attention, or null. */
  latest(encounterId: string): Promise<NoteQuestionCheck | null>;
}

export const NOTE_QUESTION_CHECK_STORE = Symbol('NOTE_QUESTION_CHECK_STORE');
