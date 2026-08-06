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
