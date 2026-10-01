import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
} from '../../../shared/domain/clinic-time';

/**
 * The family value carried by a token that has not passed the second factor.
 *
 * IN THE DOMAIN, not in the token adapter: the application decides when to
 * issue a challenge, and importing that decision from infrastructure would
 * invert the dependency — which `dependency-cruiser` catches.
 *
 * ⚠️ KNOWN SMELL, deliberately left visible. Overloading `fam` with a magic
 * value means a bug in the MFA flow cannot be told apart from a bug in the
 * session flow, and the claims schema has to special-case it. The right shape
 * is a `typ: 'mfa_challenge'` claim of its own. Recorded rather than fixed
 * silently, because changing the claim shape invalidates every live token and
 * that is a deploy-time decision, not a refactor.
 */
export const MFA_CHALLENGE_FAMILY = 'pending-mfa';

/**
 * AU-040. How much longer the refresh COOKIE lives than its session family.
 *
 * With both expiring at the same instant, the browser drops the cookie exactly
 * when the family reaches its lifetime: the next refresh carries no cookie,
 * the API can only answer «no cookie», and nobody is told the session expired.
 * A day later, the server still refuses by the row and can say why. Expired
 * rows must outlive their expiry by the same margin when they are purged.
 */
export const REFRESH_COOKIE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** AU-043. The hour of the clinic at which a session family expires (D-065). */
export const SESSION_CUTOFF = WallClockTime.of(3, 0);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * AU-040, AU-043. When the family started at `startedAt` expires: the LAST
 * 03:00 in `America/Guayaquil` no later than `lifetimeDays` days after it.
 *
 * Counted to the second, a Monday 08:10 sign-in expired the next Monday at
 * 08:10, in the middle of a consultation, every week. Aligned, it expires that
 * Monday at 03:00 with the clinic closed. ALWAYS EARLIER, NEVER LATER: the
 * ceiling D-063 set is a maximum, so the real life lies between
 * `lifetimeDays − 1` and `lifetimeDays` days.
 *
 * Pure, and in the clinic's zone whatever the server's (REQ-160).
 */
export function sessionFamilyExpiry(
  startedAt: Date,
  lifetimeDays: number,
): Date {
  const ceiling = new Date(startedAt.getTime() + lifetimeDays * MS_PER_DAY);
  const date = clinicalDateOf(ceiling);
  const sameDay = atWallClock(date, SESSION_CUTOFF);
  return sameDay <= ceiling
    ? sameDay
    : atWallClock(addDays(date, -1), SESSION_CUTOFF);
}
