import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../../shared/domain/errors/domain-error';
import { assertValidPassword } from '../domain/password-policy';

import {
  AUTH_USER_REPOSITORY,
  type AuthUser,
  type AuthUserRepositoryPort,
  type ClientContext,
  PASSWORD_HASHER,
  type PasswordHasherPort,
  REFRESH_TOKENS,
  type RefreshTokenPort,
  TOKEN_ISSUER,
  type TokenIssuerPort,
  TOTP,
  type TotpPort,
} from './ports';

export class InvalidCredentialsError extends UnauthorizedError {
  readonly code = 'INVALID_CREDENTIALS';
  constructor() {
    // Deliberately identical whether the email is unknown or the password is
    // wrong. Telling them apart lets an attacker enumerate who works here.
    super('Email or password is incorrect');
  }
}

export class AccountLockedError extends ForbiddenError {
  readonly code = 'ACCOUNT_LOCKED';
  constructor(readonly retryAfterSeconds: number) {
    super('Account is temporarily locked', { retryAfterSeconds });
  }
}

export class AccountInactiveError extends ForbiddenError {
  readonly code = 'ACCOUNT_INACTIVE';
  constructor() {
    super('Account is not active');
  }
}

export class UserNotFoundError extends NotFoundError {
  readonly code = 'USER_NOT_FOUND';
  constructor() {
    super('User does not exist');
  }
}

export class MfaNotEnrolledError extends UnauthorizedError {
  readonly code = 'MFA_NOT_ENROLLED';
  constructor() {
    super('No TOTP secret is enrolled for this account');
  }
}

export class MfaAlreadyEnrolledError extends ConflictError {
  readonly code = 'MFA_ALREADY_ENROLLED';
  constructor() {
    // Re-enrolling would silently invalidate the user's authenticator without
    // proving they still control the current one.
    super('This account already has a confirmed second factor');
  }
}

/** Why a token stopped being valid. Mirrored in the audit trail. */
export const RevocationReason = {
  ROTATION: 'ROTATION',
  REUSE: 'REUSE',
  SIGN_OUT: 'SIGN_OUT',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
} as const;

/**
 * Lockout thresholds.
 *
 * Two layers on purpose: per account here, and per IP through the throttler.
 * Account-only lets an attacker lock a doctor out of the records deliberately
 * — a denial of service on patient care. IP-only does not stop distributed
 * credential stuffing.
 */
const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 15 * 60;

/** Roles are not modelled yet; every user gets the same one for now. */
const DEFAULT_ROLES = ['STAFF'];

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

    if (!user.active) throw new AccountInactiveError();

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfter = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 1000,
      );
      throw new AccountLockedError(retryAfter);
    }

    if (!(await this.hasher.verify(user.passwordHash, password))) {
      await this.registerFailedAttempt(user.id, user.failedAttempts);
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
        fam: 'pending-mfa',
        roles: [],
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
    if (!user.mfaSecretEncrypted) throw new MfaNotEnrolledError();

    const usedStep = this.totp.verify(
      user.mfaSecretEncrypted,
      code,
      user.email,
      user.mfaLastStep,
    );

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
    if (!user) throw new UserNotFoundError();

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
      roles: DEFAULT_ROLES,
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

    await this.users.updatePasswordHash(
      userId,
      await this.hasher.hash(newPassword),
    );
    await this.refreshTokens.revokeAllForUser(
      userId,
      RevocationReason.PASSWORD_CHANGE,
    );

    this.logger.info(
      { user_id: userId, action: 'PASSWORD_CHANGED' },
      'password changed',
    );
  }

  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError();
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
      roles: DEFAULT_ROLES,
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
  private async registerFailedAttempt(
    userId: string,
    currentFailures: number,
  ): Promise<void> {
    const failures = currentFailures + 1;

    if (failures < MAX_FAILED_ATTEMPTS) {
      await this.users.recordFailedAttempt(userId, failures, null);
      return;
    }

    const overshoot = failures - MAX_FAILED_ATTEMPTS;
    const lockSeconds = Math.min(
      BASE_LOCK_SECONDS * 2 ** overshoot,
      MAX_LOCK_SECONDS,
    );

    await this.users.recordFailedAttempt(
      userId,
      failures,
      new Date(Date.now() + lockSeconds * 1000),
    );

    this.logger.warn(
      { user_id: userId, action: 'ACCOUNT_LOCKED', count: failures },
      'account locked after repeated failures',
    );
  }
}
