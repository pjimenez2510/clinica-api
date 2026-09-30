import type {
  ClientContext,
  IssuedRefreshToken,
} from '../../../shared/request/client-context';

export type { ClientContext, IssuedRefreshToken };
import type { RoleAssignment } from '../../../shared/authorisation/principal';

/**
 * Ports the authentication use cases depend on.
 *
 * WHY THESE EXIST — and why there are only four.
 *
 * The dependency rule (application must not import infrastructure) is not
 * bureaucracy here: it is what makes `AuthService` testable. Without these
 * ports, testing sign-in means running real Argon2 at ~100 ms per hash and a
 * real PostgreSQL, so the tests covering the most security-critical logic in
 * the system become slow enough that people stop running them.
 *
 * They are plain interfaces plus injection tokens. No extra classes: the
 * existing infrastructure services satisfy them as they are.
 *
 * TypeScript interfaces vanish at runtime, so a `Symbol` token is required —
 * you cannot inject by interface.
 */

/** Minimum a use case needs to know about a user. */
export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  cedula: string | null;
  active: boolean;
  mfaSecretEncrypted: string | null;
  /**
   * AU-037. The secret of a re-enrolment that has been started and not yet
   * confirmed. A SECOND field, and that is the requirement rather than a
   * convenience: the factor in `mfaSecretEncrypted` has to keep working until
   * the new one is confirmed, so the two coexist for the length of the change.
   */
  mfaPendingSecretEncrypted: string | null;
  mfaEnabledAt: Date | null;
  mfaLastStep: bigint | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * AU-001. Argon2id behind a port so sign-in tests do not spend ~100 ms per hash
 * (see the header). `needsRehash` lets sign-in upgrade parameters at the only
 * moment the plaintext is available.
 */
export interface PasswordHasherPort {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Spends the same CPU as a real verification, to flatten sign-in timing. */
  burnTime(): Promise<void>;
}

/**
 * What `AuthService` asks to be signed. `grants` are role ids and sites, never
 * permissions: those are resolved per request (AU-012).
 */
export interface AccessTokenClaimsInput {
  sub: string;
  fam: string;
  grants: RoleAssignment[];
  mfa: boolean;
}

/**
 * AU-004: the short-lived half of a session. Verification stays in the guard's
 * adapter; the use cases only issue.
 */
export interface TokenIssuerPort {
  issueAccessToken(claims: AccessTokenClaimsInput): Promise<string>;
}

/**
 * AU-004: rotating, single-use refresh tokens grouped in families. Reuse of a
 * spent token revokes the whole family; `revokeAllForUser` closes every session
 * of the account (AU-023, AU-036).
 */
export interface RefreshTokenPort {
  issueForNewSession(
    userId: string,
    ctx?: ClientContext,
  ): Promise<IssuedRefreshToken>;
  rotate(
    presentedToken: string,
    ctx?: ClientContext,
  ): Promise<IssuedRefreshToken>;
  revokeFamily(familyId: string, reason: string): Promise<void>;
  revokeAllForUser(userId: string, reason: string): Promise<void>;
}

/**
 * AU-005. The secret leaves `enroll` in clear exactly once, for the QR code;
 * only `encrypted` is ever stored.
 */
export interface TotpPort {
  enroll(email: string): { secret: string; encrypted: string; uri: string };
  /** Returns the consumed time step; the caller must persist it. */
  verify(
    encryptedSecret: string,
    code: string,
    email: string,
    lastUsedStep: bigint | null,
  ): bigint;
}

/** An unspent backup code, as persistence knows it: an id and a hash. */
export interface LiveBackupCode {
  id: string;
  codeHash: string;
}

/** Everything the use cases need from persistence. */
export interface AuthUserRepositoryPort {
  findByEmail(email: string): Promise<AuthUser | null>;
  findById(id: string): Promise<AuthUser | null>;
  findByRefreshFamily(familyId: string): Promise<AuthUser | null>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  /**
   * Increments the failure counter and returns the NEW value.
   *
   * Returns it because the caller cannot compute it: reading the count into
   * the process and writing back an absolute value loses every concurrent
   * attempt but one, and an account that never reaches the threshold never
   * locks. The increment has to happen in the database, in one statement.
   */
  registerFailure(userId: string): Promise<number>;
  applyLock(userId: string, lockedUntil: Date): Promise<void>;
  clearFailedAttempts(userId: string): Promise<void>;
  /**
   * Changes the password AND revokes every session, or does neither.
   *
   * Expressed as one operation because the atomicity is the point: if the
   * revocation fails after the password changed, an attacker's stolen session
   * survives a password change made specifically to kill it. The transaction
   * is the adapter's business; what the application declares is that these two
   * cannot come apart.
   */
  rotateCredentials(
    userId: string,
    passwordHash: string,
    revocationReason: string,
  ): Promise<void>;
  savePendingMfaSecret(userId: string, encryptedSecret: string): Promise<void>;
  recordMfaStep(userId: string, usedStep: bigint): Promise<void>;
  /**
   * AU-005. Enables the second factor AND installs its batch of backup codes,
   * REPLACING any previous one — and answers WHETHER THIS CALLER ENABLED IT.
   *
   * ONE OPERATION, AND BOTH HALVES OF THAT ARE LOAD-BEARING.
   *
   * The batch REPLACES rather than appends because a new batch exists exactly
   * when the old one is no longer trusted — the phone was lost, or the codes
   * were printed and left somewhere. Adding to it would leave the codes the
   * person believes they revoked still working.
   *
   * The two writes cannot come apart. Enabling the factor without storing the
   * codes leaves an account with a second factor and no way to recover it —
   * there is no endpoint to regenerate a batch — which is the lockout AU-005
   * exists to prevent. Storing the codes without enabling the factor leaves
   * them unreachable, which is merely useless. Neither is acceptable as a
   * durable state, so the adapter commits both or neither.
   *
   * And the boolean is the single-confirmation guarantee, which cannot be
   * computed here: a "read the user, check `mfaEnabledAt` is null, write" in
   * the process lets a double-submitted form through twice — both requests
   * carry the same TOTP code and confirmation accepts it twice by design, both
   * see an unenrolled account, both generate a batch, and under READ COMMITTED
   * neither sees the other's INSERTs, so the account ends up with TWENTY live
   * codes and the person is handed two different lists. The condition has to
   * be evaluated by the database, in the same statement that writes — exactly
   * like `registerFailure` and like `consumeBackupCode` below.
   */
  confirmMfaWithBackupCodes(
    userId: string,
    usedStep: bigint,
    codeHashes: readonly string[],
  ): Promise<boolean>;
  /**
   * AU-037. Parks the secret of a re-enrolment in progress, AND NOTHING ELSE.
   *
   * The contrast with `savePendingMfaSecret` is the whole requirement:
   * that one installs the secret in `mfaSecretEncrypted` and clears the
   * enrolment mark, which is right for a first enrolment and catastrophic for
   * a change — a person who closes the tab halfway would be left with no
   * second factor at all and no session to fix it with. This writes to a field
   * of its own so the working factor is untouched until the new one is
   * confirmed.
   */
  savePendingMfaChange(userId: string, encryptedSecret: string): Promise<void>;
  /**
   * AU-037. Swaps the confirmed secret for the pending one AND installs a new
   * batch of backup codes, or does neither — and answers WHETHER THIS CALLER
   * DID IT.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * THE CLAIM IS THE PENDING SECRET, BECAUSE `mfaEnabledAt IS NULL` CANNOT BE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `confirmMfaWithBackupCodes` arbitrates a double submission by claiming an
   * account that is NOT yet enrolled. Here the account IS enrolled — that is
   * the precondition of the whole use case — so that condition matches every
   * time and arbitrates nothing. What it is replaced by has to satisfy the
   * same argument written there: the condition is evaluated by PostgreSQL in
   * the same statement that writes, and exactly one caller can hear yes.
   *
   * That condition is `mfa_pending_secret_encrypted = <the very blob this
   * caller verified against>`. It is claimed and cleared in the same UPDATE,
   * so:
   *
   *   - THE DOUBLE-CLICKED FORM loses. Both requests carry the same TOTP code
   *     and both pass it (confirmation deliberately compares against no last
   *     step), both generate a batch; the first takes the row lock and nulls
   *     the pending secret, the second re-reads under READ COMMITTED, matches
   *     nothing and writes nothing. Two winners here would be two batches of
   *     ten live codes and a person holding two lists.
   *   - A RE-ENROLMENT STARTED TWICE cannot be confirmed with the abandoned
   *     one. Matching on `IS NOT NULL` would let a confirmation for the FIRST
   *     pending secret install the SECOND one — a secret whose QR code that
   *     person may never have scanned, which is a lockout produced by our own
   *     write.
   *
   * ONE TRANSACTION, for the reason `confirmMfaWithBackupCodes` gives: the gap
   * between the two statements is an account whose factor has just changed and
   * whose backup codes are the old ones, still printed on a piece of paper the
   * person believes they have just replaced.
   */
  replaceMfaSecretWithBackupCodes(
    userId: string,
    pendingSecretEncrypted: string,
    usedStep: bigint,
    codeHashes: readonly string[],
  ): Promise<boolean>;
  /**
   * The codes not yet spent. Only the unused ones: filtering afterwards is a
   * step somebody can forget, and forgetting it makes them reusable.
   *
   * ⚠️ It returns EVERY live hash because there is no way to look one up —
   * Argon2 is salted, so a presented code has to be tried against each. The
   * cost of that loop is what caps `BACKUP_CODE_COUNT`; see `backup-code.ts`.
   */
  findLiveBackupCodes(userId: string): Promise<LiveBackupCode[]>;
  /**
   * Spends one code, and answers WHETHER THIS CALLER WAS THE ONE THAT SPENT IT.
   *
   * The boolean is the single-use guarantee and it cannot be computed here: a
   * "read it, check it is unused, write it" in the process lets two concurrent
   * requests both read "unused" and both proceed, so the same code opens two
   * sessions. The condition has to be evaluated by the database, in the same
   * statement that writes — exactly like `registerFailure` and like the
   * refresh token claim.
   */
  consumeBackupCode(backupCodeId: string): Promise<boolean>;
  /** Roles currently in force. Revoked grants are excluded by the query. */
  findActiveGrants(userId: string): Promise<RoleAssignment[]>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
export const REFRESH_TOKENS = Symbol('REFRESH_TOKENS');
export const TOTP = Symbol('TOTP');
export const AUTH_USER_REPOSITORY = Symbol('AUTH_USER_REPOSITORY');
