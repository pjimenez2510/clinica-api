import type { HeardWord } from '../domain/heard-doubts';

/** AS-180. What `clinica-ai` heard in a dictation, and how long the recording was. */
export interface DictationHeard {
  text: string;
  /** AS-197. Each token with its probability; empty when clinica-ai gave none. */
  words: HeardWord[];
  /** How long the recording was, not how long recognising it took. */
  seconds: number;
}

/**
 * AS-180, AS-184, AS-186. The short dictation on the other side of
 * `clinica-ai` (whisper.cpp with voice detection, on this machine). The
 * recording is handed over and forgotten; nothing of it, nor of the text, is
 * kept or logged. Throws `DictationNotHeardError` when there was nothing to
 * read and `DictationUnavailableError` when it cannot transcribe.
 */
export interface DictationTranscriber {
  transcribe(recording: Buffer, signal?: AbortSignal): Promise<DictationHeard>;
}

export const DICTATION_TRANSCRIBER = Symbol('DICTATION_TRANSCRIBER');
