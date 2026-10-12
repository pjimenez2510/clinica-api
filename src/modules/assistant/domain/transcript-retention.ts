/**
 * AS-057 (D-239 §3). How long the transcript of a consultation is kept: 45
 * days after its note is first signed. The author's figure.
 */
export const TRANSCRIPT_RETENTION_DAYS = 45;

/**
 * AS-057 (D-247 §2). The ceiling for a transcript whose attention is never
 * signed — opened in error, interrupted — counted from each segment.
 * Recommendation awaiting the author, as D-241 §6.
 */
export const TRANSCRIPT_MAX_DAYS = 90;

const DAY_MS = 86_400_000;

/** The instants before which a segment has outlived each rule. */
export function transcriptPurgeCutoffs(now: Date): {
  retention: Date;
  maximum: Date;
} {
  return {
    retention: new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * DAY_MS),
    maximum: new Date(now.getTime() - TRANSCRIPT_MAX_DAYS * DAY_MS),
  };
}
