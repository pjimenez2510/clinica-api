import type { AudioFrame } from '../domain/listening';

/** A window the recogniser confirmed, on the clock of the consultation. */
export interface RecognizedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * How a recognition ended without being asked to. `expired`: `clinica-ai`
 * closed it for its own limits (1001: idle, or the longest listening), and a
 * new one continues on the same clock (AS-055). `failed`: it crashed, was full
 * or went away — the listening pauses.
 */
export type RecognitionEnd = 'expired' | 'failed';

export interface RecognizerEvents {
  onSegment(segment: RecognizedSegment): void;
  /** Once, when the recognition ended by itself. Never after `end()` resolved. */
  onEnded(how: RecognitionEnd): void;
}

export interface RecognitionSession {
  /**
   * Hands a frame over and forgets it: nothing is buffered beyond the call
   * (AS-053). `false` when the recognition is closing or closed: how it ended
   * arrives by `onEnded`, and the frame is not counted as heard.
   */
  send(frame: AudioFrame): boolean;
  /**
   * AS-050. Asks the recogniser to finish what it holds and waits until every
   * segment was handed over; rejects when it went away or took too long.
   */
  end(): Promise<void>;
  /** Closes without waiting for anything: the process is shutting down. */
  abort(): void;
}

/**
 * The recogniser on the other side of `clinica-ai` (whisper.cpp with voice
 * detection, on this machine). `open` throws `ListeningUnavailableError` when
 * it cannot listen (AS-048).
 */
export interface SpeechRecognizer {
  open(events: RecognizerEvents): Promise<RecognitionSession>;
}

export const SPEECH_RECOGNIZER = Symbol('SPEECH_RECOGNIZER');
