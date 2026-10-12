/**
 * AS-087. What the listening tells whoever drafts from its transcript: it grew
 * (segments kept, up to `upToMs`) and the physician stopped it. Never awaited
 * by the listening: a draft that cannot be asked for does not touch the
 * capture.
 */
export interface TranscriptObserver {
  transcriptGrew(encounterId: string, upToMs: number): void;
  listeningStopped(encounterId: string): void;
}

export const TRANSCRIPT_OBSERVER = Symbol('TRANSCRIPT_OBSERVER');
