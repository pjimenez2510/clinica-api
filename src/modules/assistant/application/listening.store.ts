import type { ListeningState, PauseReason } from '../domain/listening';

import type { RecognizedSegment } from './speech-recognizer.port';

/** AS-049. The listening of an attention as it is written down. */
export interface StoredListening {
  encounterId: string;
  state: ListeningState;
  offsetMs: number;
  reason: PauseReason | null;
  device: string;
  startedBy: string;
  startedAt: Date;
  updatedAt: Date;
}

export interface TranscriptLine {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ListeningStore {
  find(encounterId: string): Promise<StoredListening | null>;
  /** Writes the listening down, replacing the one the attention had. */
  save(listening: StoredListening): Promise<void>;
  /**
   * AS-049. Moves the clock of a listening that is still `LISTENING`, and
   * nothing else: a pause written meanwhile is not overwritten.
   */
  advance(encounterId: string, offsetMs: number, at: Date): Promise<void>;
  /**
   * AS-052. Keeps what the recogniser confirmed; a segment already kept (same
   * attention, same start) is left as it was, never duplicated.
   */
  append(
    encounterId: string,
    segments: readonly RecognizedSegment[],
    at: Date,
  ): Promise<void>;
  /** AS-056. The transcript, in order of start. */
  transcript(encounterId: string): Promise<TranscriptLine[]>;
  /** AS-057. Deletes what outlived its days; answers how many. */
  purge(now: Date): Promise<number>;
}

export const LISTENING_STORE = Symbol('LISTENING_STORE');

/** AS-241, AS-245 (B3). The store of the preparation's listening. */
export const PREPARATION_LISTENING_STORE = Symbol(
  'PREPARATION_LISTENING_STORE',
);
