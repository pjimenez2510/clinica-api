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
