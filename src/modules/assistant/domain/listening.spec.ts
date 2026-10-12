import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_MS,
  MAX_FRAME_BYTES,
  frameEndMs,
  unheardPart,
} from './listening';

/** A frame of `ms` milliseconds of PCM16 at 16 kHz. */
const pcm = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS, 1);

describe('the clock of the listening (AS-049)', () => {
  it('AS-049: forwards a frame that starts where the clock is, whole', () => {
    const part = unheardPart({ offsetMs: 1_000, pcm: pcm(100) }, 1_000);

    expect(part).toEqual({ offsetMs: 1_000, pcm: pcm(100) });
  });

  it('AS-049: drops a frame the server already received', () => {
    expect(unheardPart({ offsetMs: 900, pcm: pcm(100) }, 1_000)).toBeNull();
    expect(unheardPart({ offsetMs: 0, pcm: pcm(100) }, 1_000)).toBeNull();
  });

  it('AS-049: forwards only the tail of a frame that overlaps what was received', () => {
    const part = unheardPart({ offsetMs: 950, pcm: pcm(100) }, 1_000);

    expect(part?.offsetMs).toBe(1_000);
    expect(part?.pcm.length).toBe(50 * BYTES_PER_MS);
  });

  it('AS-049: forwards a frame after a gap at its own start', () => {
    expect(
      unheardPart({ offsetMs: 1_500, pcm: pcm(100) }, 1_000)?.offsetMs,
    ).toBe(1_500);
  });

  it('AS-049: ends a partial frame on a whole millisecond', () => {
    // 10202.75 ms broke SigmAI's integer column (E-031).
    expect(frameEndMs(10_100, Buffer.alloc(3_288))).toBe(10_203);
  });

  it('AS-053: one second of audio is the largest frame', () => {
    expect(MAX_FRAME_BYTES).toBe(1_000 * BYTES_PER_MS);
  });
});
