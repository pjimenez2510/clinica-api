import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_MAX_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
  transcriptPurgeCutoffs,
} from './transcript-retention';

describe('how long a transcript is kept (AS-057)', () => {
  it('AS-057: 45 days after the signature, and 90 at most from each segment', () => {
    const now = new Date(Date.UTC(2026, 9, 12, 15)); // fecha-fija: instante de referencia del cálculo
    const day = 86_400_000;

    expect(TRANSCRIPT_RETENTION_DAYS).toBe(45);
    expect(TRANSCRIPT_MAX_DAYS).toBe(90);
    expect(transcriptPurgeCutoffs(now)).toEqual({
      retention: new Date(now.getTime() - 45 * day),
      maximum: new Date(now.getTime() - 90 * day),
    });
  });
});
