import type { NoteDraftStatus } from '../domain/note-draft';

/** AS-086. A draft asked for, as `note_draft` keeps it: no text (AS-095). */
export interface StoredNoteDraft {
  id: string;
  encounterId: string;
  upToMs: number;
  status: NoteDraftStatus;
  failureCode: string | null;
  /** AS-093. How many times this stretch was asked for. */
  attempts: number;
  requestedBy: string;
  aiRunId: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NoteDraftStore {
  ofStretch(encounterId: string, upToMs: number): Promise<StoredNoteDraft | null>; // prettier-ignore
  /** The newest asked for, whatever its state. */
  latest(encounterId: string): Promise<StoredNoteDraft | null>;
  latestDone(encounterId: string): Promise<StoredNoteDraft | null>;
  /** AS-090. The drafts of the attention that finished: only their sections are shown. */
  doneIds(encounterId: string): Promise<string[]>;
  inFlight(encounterId: string): Promise<StoredNoteDraft | null>;
  /**
   * AS-086. Queues a new draft; null when the database refused it because
   * another one is in flight or the stretch already has one — the caller
   * reads again and answers that one.
   */
  queue(input: {
    encounterId: string;
    upToMs: number;
    requestedBy: string;
    at: Date;
  }): Promise<StoredNoteDraft | null>;
  /**
   * «Volver a pedir»: a failed draft back in the queue, one attempt more;
   * null if it was not failed, already had `maxAttempts`, or another is in
   * flight.
   */
  requeue(id: string, requestedBy: string, at: Date, maxAttempts: number): Promise<StoredNoteDraft | null>; // prettier-ignore
  /** `QUEUED` → `RUNNING`; false when it was not queued any more. */
  start(id: string, at: Date): Promise<boolean>;
  /** False when it was not running any more (it failed meanwhile). */
  succeed(id: string, aiRunId: string, at: Date): Promise<boolean>;
  fail(id: string, code: string, at: Date): Promise<void>;
  /** AS-093. At boot, what was in flight failed: answers how many. */
  failInFlight(code: string, at: Date): Promise<number>;
}

export const NOTE_DRAFT_STORE = Symbol('NOTE_DRAFT_STORE');
