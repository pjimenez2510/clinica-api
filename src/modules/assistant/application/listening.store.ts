import type {
  ListeningState,
  PauseReason,
  Speaker,
  SpeakerSource,
} from '../domain/listening';

import type {
  RecognizedSegment,
  SpeakerChange,
} from './speech-recognizer.port';

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
  /** AS-315. Null, or absent, on a line heard without the voiceprint. */
  speaker?: Speaker | null;
  speakerSource?: SpeakerSource | null;
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
  /**
   * AS-316. The model's corrections, except on lines the professional
   * labelled by hand; answers the ones that changed.
   */
  relabel(
    encounterId: string,
    changes: readonly SpeakerChange[],
  ): Promise<SpeakerChange[]>;
  /** AS-317. The professional's label; `false` when the line is not there. */
  label(
    encounterId: string,
    startMs: number,
    speaker: Speaker,
  ): Promise<boolean>;
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
