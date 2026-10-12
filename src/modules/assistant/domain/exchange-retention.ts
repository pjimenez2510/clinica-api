/**
 * AS-015 (D-239 §3). How long the text of an attempt is kept: 45 days after
 * the encounter's note is signed — counted from the attempt when the text was
 * written after the signature (an amendment) — and 45 days after the attempt
 * when there is no encounter (D-241 §2). The author's figure.
 */
export const EXCHANGE_RETENTION_DAYS = 45;

/**
 * AS-015 (D-241 §6). The ceiling for text whose encounter is never signed — a
 * chart opened in error, an interrupted visit — which the 45 days would
 * otherwise never reach. Recommendation awaiting the author.
 */
export const EXCHANGE_MAX_DAYS = 90;

const DAY_MS = 86_400_000;

/** The instants before which a text has outlived each rule. */
export function exchangePurgeCutoffs(now: Date): {
  retention: Date;
  maximum: Date;
} {
  return {
    retention: new Date(now.getTime() - EXCHANGE_RETENTION_DAYS * DAY_MS),
    maximum: new Date(now.getTime() - EXCHANGE_MAX_DAYS * DAY_MS),
  };
}
