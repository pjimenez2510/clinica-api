/**
 * C1. The listening of a consultation, as rules without a framework.
 *
 * The audio is PCM16 at 16 kHz, mono: 32 bytes per millisecond. Every frame
 * carries where it starts on the clock of the consultation (AS-049), so a
 * pause, a cut or a reload continue the same clock instead of renumbering it.
 */

/** PCM16 (2 bytes) × 16 000 samples per second. */
export const BYTES_PER_MS = 32;

/**
 * AS-053. One second of audio: the largest frame `clinica-ai` accepts
 * (CAI-015). The browser sends a tenth of a second.
 */
export const MAX_FRAME_BYTES = 1_000 * BYTES_PER_MS;

export type ListeningState = 'LISTENING' | 'PAUSED' | 'STOPPED';

/**
 * AS-051, AS-055. Why the system paused a listening nobody paused. Codes, not
 * sentences: they reach logs and screens (AS-058), and the screen words them.
 */
export type PauseReason = 'device-lost' | 'recognizer-failed' | 'store-failed';

/**
 * AS-048. Why `clinica-ai` cannot listen right now. `no-voice-detection` is
 * a refusal of this side: without it whisper writes sentences nobody said.
 */
export type UnavailableReason =
  'no-recognizer' | 'no-voice-detection' | 'unreachable';

export interface AudioFrame {
  /** Where the frame starts on the clock of the consultation, in ms. */
  offsetMs: number;
  /** PCM16 at 16 kHz. Never written anywhere (AS-053). */
  pcm: Buffer;
}

/**
 * AS-049. Where a frame ends on the clock, in whole milliseconds: a partial
 * frame lasts 10202.75 ms, and the clock is an integer column (E-031).
 */
export function frameEndMs(offsetMs: number, pcm: Buffer): number {
  return Math.round(offsetMs + pcm.length / BYTES_PER_MS);
}

/**
 * AS-049, AS-060. What of a frame the server has not received yet.
 *
 * The browser resends what it is not sure arrived, so a frame may repeat what
 * already went to the recogniser: that part is dropped, and only the new tail
 * is forwarded, starting exactly where the clock is. A frame after a gap goes
 * as it is, at its own start. `null` when there is nothing new.
 */
export function unheardPart(
  frame: AudioFrame,
  receivedUpToMs: number,
): AudioFrame | null {
  if (frame.offsetMs >= receivedUpToMs) return frame;

  const skipBytes = (receivedUpToMs - frame.offsetMs) * BYTES_PER_MS;
  if (skipBytes >= frame.pcm.length) return null;

  return { offsetMs: receivedUpToMs, pcm: frame.pcm.subarray(skipBytes) };
}
