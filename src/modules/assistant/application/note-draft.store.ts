import type { NoteDraftStatus } from '../domain/note-draft';

/** AS-086. A draft asked for, as `note_draft` keeps it: no text (AS-095). */
export interface StoredNoteDraft {
  id: string;
  encounterId: string;
  upToMs: number;
  status: NoteDraftStatus;
  failureCode: string | null;
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
  /** «Volver a pedir»: a failed draft back in the queue; null if it was not failed or another is in flight. */
  requeue(id: string, requestedBy: string, at: Date): Promise<StoredNoteDraft | null>; // prettier-ignore
  /** `QUEUED` → `RUNNING`; false when it was not queued any more. */
  start(id: string, at: Date): Promise<boolean>;
  succeed(id: string, aiRunId: string, at: Date): Promise<void>;
  fail(id: string, code: string, at: Date): Promise<void>;
  /** AS-093. At boot, what was in flight failed: answers how many. */
  failInFlight(code: string, at: Date): Promise<number>;
}

export const NOTE_DRAFT_STORE = Symbol('NOTE_DRAFT_STORE');
