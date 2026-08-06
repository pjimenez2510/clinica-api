import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  AccountInactiveError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  MfaAlreadyEnrolledError,
  MfaNotEnrolledError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import { assertValidPassword } from '../domain/password-policy';

import {
  AUTH_USER_REPOSITORY,
  type AuthUser,
  type AuthUserRepositoryPort,
  PASSWORD_HASHER,
  type PasswordHasherPort,
  REFRESH_TOKENS,
  type RefreshTokenPort,
  TOKEN_ISSUER,
  type TokenIssuerPort,
  TOTP,
  type TotpPort,
} from './ports';
import { MFA_CHALLENGE_FAMILY } from '../domain/session';
// One definition, in shared: the audit log needs the same shapes, and the
// audit log is not auth's business.
import {
  type ClientContext,
  RevocationReason,
} from '../../../shared/request/client-context';

export { type ClientContext, RevocationReason };

/**
 * The errors these use cases raise live in `../domain/auth.errors`.
 *
 * Re-exported so existing imports keep working, but the definitions belong to
 * the domain: an error is a lightweight value and importing it should not drag
 * in this service, its five ports and the whole of NestJS.
 */
export {
  AccountInactiveError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  InvalidRefreshTokenError,
  MfaAlreadyEnrolledError,
  MfaNotEnrolledError,
  MfaRequiredError,
  RefreshTokenReuseError,
  SessionUserMissingError,
} from '../domain/auth.errors';

/**
 * Lockout thresholds.
 *
 * Two layers on purpose: per account here, and per IP through the throttler.
 * Account-only lets an attacker lock a doctor out of the records deliberately
 * — a denial of service on patient care. IP-only does not stop distributed
 * credential stuffing.
 */
const MAX_FAILED_ATTEMPTS = 5;
/**
 * Lower for TOTP: a six-digit code is not mistyped five times, and the search
 * space is 10^6 with three codes valid at once because of the window. Sharing
 * the password threshold would leave the SECOND factor easier to brute-force
 * than the first.
 */
const MAX_MFA_ATTEMPTS = 3;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 15 * 60;

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  user: { id: string; email: string; firstName: string; lastName: string };
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
}

/**
 * Authentication operations.
 *
 * Kept as one cohesive service rather than five single-method use case classes:
 * they all share user lookup, lockout accounting and session issuance, so
 * splitting them would duplicate wiring without isolating anything.
 *
 * Every dependency is a port. That is what lets these flows be tested with
 * in-memory fakes instead of real Argon2 and a real database.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuerPort,
    @Inject(REFRESH_TOKENS) private readonly refreshTokens: RefreshTokenPort,
    @Inject(TOTP) private readonly totp: TotpPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  /**
   * Verifies credentials.
   *
   * Returns either a full session, or an MFA challenge when the account has a
   * confirmed second factor.
   */
  async signIn(
    email: string,
    password: string,
    ctx: ClientContext = {},
  ): Promise<AuthenticatedSession | MfaChallenge> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      // Spend the same CPU a real verification would. Without this, unknown
      // accounts answer noticeably faster and that timing gap is an oracle.
      await this.hasher.burnTime();
      throw new InvalidCredentialsError();
    }

    /**
     * A locked or inactive account answers exactly like a wrong password.
     *
     * It used to answer 403 ACCOUNT_LOCKED and 403 ACCOUNT_INACTIVE, and that
     * was an enumeration oracle — not a passive one. An attacker did not have
     * to wait for an account to happen to be locked: five wrong guesses LOCK
     * it, and the change from 401 to 403 confirms the address belongs to
     * somebody who works here. The same move also denies that person access on
     * purpose, one doctor at a time.
     *
     * `burnTime` before returning, and BEFORE verifying anything, so a locked
     * account costs the same as a real verification. Returning early without
     * it left a ~100 ms gap that survives any amount of unifying the response
     * body. Checking the lock before the hash also keeps a flood against a
     * locked account from spending Argon2 CPU.
     *
     * The real reason is logged. The person who is genuinely locked out finds
     * out through an administrator, not through an endpoint that answers
     * anyone who can type their email address.
     */
    const denialReason = !user.active
      ? 'ACCOUNT_INACTIVE'
      : this.isLocked(user)
        ? 'ACCOUNT_LOCKED'
        : undefined;

    if (denialReason) {
      await this.hasher.burnTime();
      this.logger.warn(
        { user_id: user.id, error_code: denialReason },
        'sign-in denied',
      );
      throw new InvalidCredentialsError();
    }

    if (!(await this.hasher.verify(user.passwordHash, password))) {
      await this.registerFailedAttempt(user.id, MAX_FAILED_ATTEMPTS);
      throw new InvalidCredentialsError();
    }

    await this.users.clearFailedAttempts(user.id);

    // The only moment the plaintext is available, so the only moment the hash
    // can be upgraded to stronger parameters.
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(
        user.id,
        await this.hasher.hash(password),
      );
    }

    if (user.mfaEnabledAt && user.mfaSecretEncrypted) {
      // A token with mfa:false only opens the MFA endpoints. Issuing a full
      // session here would make the second factor decorative.
      const challengeToken = await this.tokens.issueAccessToken({
        sub: user.id,
        fam: MFA_CHALLENGE_FAMILY,
        grants: [],
        mfa: false,
      });
      return { mfaRequired: true, challengeToken };
    }

    return this.issueSession(user, ctx);
  }

  /** Completes sign-in by validating the TOTP code. */
  async verifyMfa(
    userId: string,
    code: string,
    ctx: ClientContext = {},
  ): Promise<AuthenticatedSession> {
    const user = await this.requireUser(userId);

    /**
     * The second factor gets the same brake as the first.
     *
     * Without this, a wrong code cost nothing: no counter, no lock, no record.
     * The only limit was the per-IP throttle, and the challenge token stays
     * valid for the full fifteen minutes — so rotating addresses was enough to
     * walk 10^6 codes, with three of them valid at any moment. The second
     * factor was the weaker one.
     */
    if (this.isLocked(user)) {
      this.logger.warn(
        { user_id: user.id, error_code: 'ACCOUNT_LOCKED' },
        'mfa verification denied',
      );
      throw new InvalidMfaCodeError();
    }

    if (!user.mfaSecretEncrypted) throw new MfaNotEnrolledError();

    let usedStep: bigint;
    try {
      usedStep = this.totp.verify(
        user.mfaSecretEncrypted,
        code,
        user.email,
        user.mfaLastStep,
      );
    } catch (error) {
      await this.registerFailedAttempt(user.id, MAX_MFA_ATTEMPTS);
      throw error;
    }

    await this.users.clearFailedAttempts(user.id);

    // Persisting the step is what makes replay detection work. Without it the
    // code stays usable for its whole 30 second window.
    await this.users.recordMfaStep(user.id, usedStep);

    return this.issueSession(user, ctx);
  }

  /**
   * Starts TOTP enrolment.
   *
   * The secret is stored immediately but stays disabled until confirmed.
   * Keeping the pending secret server-side rather than handing the encrypted
   * blob to the client removes a whole class of replay: the client never holds
   * anything it could send back later.
   *
   * The plaintext secret is returned exactly once, for the QR code.
   */
  async enrollMfa(userId: string): Promise<{ secret: string; uri: string }> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabledAt) throw new MfaAlreadyEnrolledError();

    const { secret, encrypted, uri } = this.totp.enroll(user.email);
    await this.users.savePendingMfaSecret(userId, encrypted);

    return { secret, uri };
  }

  /** Confirms enrolment: proves the user actually scanned the QR code. */
  async confirmMfaEnrollment(userId: string, code: string): Promise<void> {
    const user = await this.requireUser(userId);

    if (!user.mfaSecretEncrypted) throw new MfaNotEnrolledError();
    if (user.mfaEnabledAt) throw new MfaAlreadyEnrolledError();

    const usedStep = this.totp.verify(
      user.mfaSecretEncrypted,
      code,
      user.email,
      null,
    );
    await this.users.confirmMfa(userId, usedStep);

    this.logger.info(
      { user_id: userId, action: 'MFA_ENROLLED' },
      'second factor enrolled',
    );
  }

  /** Rotates the session. Reuse detection lives in the refresh token port. */
  async refresh(
    presentedToken: string,
    ctx: ClientContext = {},
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const rotated = await this.refreshTokens.rotate(presentedToken, ctx);

    const user = await this.users.findByRefreshFamily(rotated.familyId);
    if (!user) throw new SessionUserMissingError();

    if (!user.active) {
      await this.refreshTokens.revokeAllForUser(
        user.id,
        RevocationReason.SIGN_OUT,
      );
      throw new AccountInactiveError();
    }

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      fam: rotated.familyId,
      grants: await this.users.findActiveGrants(user.id),
      mfa: true,
    });

    return {
      accessToken,
      refreshToken: rotated.token,
      expiresAt: rotated.expiresAt,
    };
  }

  /** Closes the current session only. Other devices stay signed in. */
  async signOut(familyId: string): Promise<void> {
    await this.refreshTokens.revokeFamily(familyId, RevocationReason.SIGN_OUT);
  }

  /**
   * Changes the password and closes every session.
   *
   * Revoking all sessions is the point: if the password was changed because it
   * leaked, leaving the attacker's session alive defeats the purpose.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.requireUser(userId);

    if (!(await this.hasher.verify(user.passwordHash, currentPassword))) {
      throw new InvalidCredentialsError();
    }

    assertValidPassword(newPassword, {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      cedula: user.cedula ?? undefined,
    });

    // ONE operation, not two. Changing the password and cutting the sessions
    // must not come apart: a failure between them leaves the attacker's stolen
    // session alive after a password change made specifically to kill it.
    await this.users.rotateCredentials(
      userId,
      await this.hasher.hash(newPassword),
      RevocationReason.PASSWORD_CHANGE,
    );

    this.logger.info(
      { user_id: userId, action: 'PASSWORD_CHANGED' },
      'password changed',
    );
  }

  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new SessionUserMissingError();
    return user;
  }

  private async issueSession(
    user: AuthUser,
    ctx: ClientContext,
  ): Promise<AuthenticatedSession> {
    const refresh = await this.refreshTokens.issueForNewSession(user.id, ctx);

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      fam: refresh.familyId,
      // Read at issue time, not cached: a role revoked before this sign-in
      // must not travel in the token that sign-in produces.
      grants: await this.users.findActiveGrants(user.id),
      mfa: true,
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresAt: refresh.expiresAt,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }

  /** Exponential backoff, capped. Linear delays are trivial to wait out. */
  /**
   * Counts a failure and locks the account once it crosses the threshold.
   *
   * The count comes back FROM the database. Computing it here from a value
   * read at the start of the request loses every concurrent attempt but one,
   * and an account that never reaches the threshold never locks.
   */
  /** Whether the account is serving a lockout right now. */
  private isLocked(user: AuthUser): boolean {
    return user.lockedUntil !== null && user.lockedUntil > new Date();
  }

  private async registerFailedAttempt(
    userId: string,
    maxAttempts: number,
  ): Promise<void> {
    const failures = await this.users.registerFailure(userId);

    if (failures < maxAttempts) return;

    const overshoot = failures - maxAttempts;
    const lockSeconds = Math.min(
      BASE_LOCK_SECONDS * 2 ** overshoot,
      MAX_LOCK_SECONDS,
    );

    await this.users.applyLock(
      userId,
      new Date(Date.now() + lockSeconds * 1000),
    );

    this.logger.warn(
      { user_id: userId, action: 'ACCOUNT_LOCKED', count: failures },
      'account locked after repeated failures',
    );
  }
}
