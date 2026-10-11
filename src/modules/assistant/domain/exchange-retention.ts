/**
 * AS-015 (D-239 §3). How long the text of an attempt is kept: 45 days after
 * the encounter's note is signed, and — with no encounter — 45 days after the
 * attempt (D-241 §2). The author's figure, not a technical default.
 */
export const EXCHANGE_RETENTION_DAYS = 45;

/** The instant before which a signature (or an attempt) has outlived it. */
export function exchangePurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - EXCHANGE_RETENTION_DAYS * 86_400_000);
}
