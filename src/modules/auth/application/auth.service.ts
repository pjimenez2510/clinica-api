import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  AccountInactiveError,
  InvalidCredentialsError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import { assertValidPassword } from '../domain/password-policy';

import { AccountLockout, MAX_FAILED_ATTEMPTS } from './account-lockout';
import { SecondFactorVerifier } from './second-factor-verifier';
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
} from './ports';
import { MFA_CHALLENGE_FAMILY } from '../domain/session';
// One definition, in shared: the audit log needs the same shapes, and the
// audit log is not auth's business.
import {
  type ClientContext,
  RevocationReason,
} from '../../../shared/request/client-context';

/**
 * A complete session: the short-lived access token and the rotating refresh
 * token of AU-004, plus what the client needs to greet the person.
 */
export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  user: { id: string; email: string; firstName: string; lastName: string };
  /**
   * AU-005, AU-037. Whether THIS account has a second factor enrolled.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * IT IS THE OWNER'S OWN DATA, AND IT TRAVELS WITH THE SESSION FOR THAT
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The only place it could be read before was `UserAccountDto`, from
   * `GET /auth/users` — administration, `user:read` over the whole payroll. So
   * a person could not find out about THEIR OWN account without a permission
   * to inspect everybody else's, and the screen offering «matricular» and
   * «cambiar de dispositivo» had to offer both and let one of them fail.
   *
   * ONE BOOLEAN AND NOTHING MORE. Not the secret, not `mfaEnabledAt`, not the
   * last consumed step, and above all not how many backup codes are left: that
   * number tells anyone reading over a shoulder how close the account is to
   * being locked out of the medical records, and it is the kind of detail
   * AU-002 refuses to answer about a session.
   *
   * `mfaEnabledAt != null` is the SAME condition `MfaEnrolmentService` guards
   * enrolment with, so «false» means enrolling will be accepted rather than
   * merely that some other column looked empty.
   */
  mfaEnabled: boolean;
}

/**
 * Returned by `signIn` INSTEAD of a session when the account has a confirmed
 * second factor. The challenge token carries `mfa: false` and no grants, so
 * `JwtAuthGuard` admits it only on `@MfaFlowOnly()` routes; the real session
 * is issued once the second factor is proved.
 */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
}

/**
 * Authentication operations.
 *
 * Kept as one cohesive service rather than five single-method use case classes:
 * they all share user lookup and session issuance, so splitting them would
 * duplicate wiring without isolating anything.
 *
 * WHAT DID COME OUT, and only because a second caller appeared for it:
 * `AccountLockout` and `SecondFactorVerifier`. AU-037 needs the second factor
 * verified — with its lockout accounting — outside any sign-in, and the one
 * thing that could not be allowed is two implementations of «is this the right
 * code?» answering differently.
 *
 * Every remaining dependency is a port or an application collaborator. That is
 * what lets these flows be tested with in-memory fakes instead of real Argon2
 * and a real database.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuerPort,
    @Inject(REFRESH_TOKENS) private readonly refreshTokens: RefreshTokenPort,
    private readonly lockout: AccountLockout,
    /**
     * AU-005, AU-037. The same question this service asks to finish a sign-in
     * is the one `MfaEnrolmentService` asks before letting somebody replace
     * their factor, so it lives in one collaborator instead of two copies.
     */
    private readonly secondFactor: SecondFactorVerifier,
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
      : this.lockout.isLocked(user)
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
      await this.lockout.registerFailedAttempt(user.id, MAX_FAILED_ATTEMPTS);
      throw new InvalidCredentialsError();
    }

    await this.users.clearFailedAttempts(user.id);

    // The only moment the plaintext is available, so the only moment the hash
    // can be upgraded to stronger parameters.
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(
        user.id,
        await this.hasher.hash(password),
        user.passwordHash,
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
        // AU-041: the epoch read with the password travels with the challenge.
        sep: user.sessionEpoch,
      });
      return { mfaRequired: true, challengeToken };
    }

    return this.issueSession(user, ctx);
  }

  /**
   * Completes sign-in with the second factor: the TOTP code, or one of the
   * backup codes (AU-005).
   *
   * AU-041, AU-023. `challengeEpoch` is the session epoch the challenge
   * carries — the one read with the password, possibly minutes ago. The
   * session is issued against IT, not against the epoch read now: closing
   * every session of the account in between (a deactivation, a password
   * change, a reset, a redeemed invitation) voids the challenge. A challenge
   * without one — issued before this existed — is refused the same way. And
   * an inactive account is refused outright, like at the password (AU-002).
   */
  async verifyMfa(
    userId: string,
    challengeEpoch: number | undefined,
    code: string,
    ctx: ClientContext = {},
  ): Promise<AuthenticatedSession> {
    const user = await this.requireUser(userId);
    // Checked BEFORE the code: a voided challenge must not spend a backup
    // code or a TOTP step. The guard already refuses these; this is the same
    // rule where the session is actually issued.
    if (
      !user.active ||
      challengeEpoch === undefined ||
      user.sessionEpoch !== challengeEpoch
    ) {
      await this.hasher.burnTime();
      this.logger.warn(
        {
          user_id: user.id,
          error_code: user.active ? 'MFA_CHALLENGE_VOIDED' : 'ACCOUNT_INACTIVE',
        },
        'second factor refused before verification',
      );
      throw new InvalidCredentialsError();
    }

    // Everything the second factor means — the TOTP window, the backup code,
    // the padding, the lockout and the deliberately identical refusal — is
    // `SecondFactorVerifier`'s, because AU-037 asks the same question before a
    // re-enrolment and two copies of it would answer differently.
    await this.secondFactor.verify(user, code);

    return this.issueSession({ ...user, sessionEpoch: challengeEpoch }, ctx);
  }

  /**
   * Rotates the session. Reuse detection lives in the refresh token port.
   *
   * RETURNS THE IDENTITY, not just the token. A browser reload loses the
   * in-memory access token, and this endpoint is the only way back — so if it
   * answers with a token and nothing else, the client holds a valid session it
   * cannot describe: signed in, but unable to say as whom or with which
   * permissions. That is exactly what happened, and it rendered an empty
   * dashboard on every reload.
   *
   * It costs nothing: the user is already loaded below to check `active`.
   */
  async refresh(
    presentedToken: string,
    ctx: ClientContext = {},
  ): Promise<AuthenticatedSession> {
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
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      // Read from the user just loaded, not carried over from the session
      // being rotated: a factor enrolled — or reset by an administrator
      // (AU-035) — since the last refresh has to be what the client hears.
      mfaEnabled: user.mfaEnabledAt !== null,
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

  /**
   * A missing account here means a valid token over a subject that no longer
   * exists, so the answer is 401 `SessionUserMissingError`, not a 404.
   */
  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new SessionUserMissingError();
    return user;
  }

  /**
   * Opens a new refresh family and signs an access token tied to it with `mfa:
   * true`. Only reached once every required factor has been proved.
   *
   * AU-041: `user` is the account as it was read with the credentials just
   * proved. If every session of it was closed since — a password change, a
   * deactivation, a second-factor reset, a redeemed invitation — no family is
   * issued, and the answer is AU-002's: the credentials that were checked may
   * be exactly the ones that were just replaced.
   */
  private async issueSession(
    user: AuthUser,
    ctx: ClientContext,
  ): Promise<AuthenticatedSession> {
    const refresh = await this.refreshTokens.issueForNewSession(
      user.id,
      user.sessionEpoch,
      ctx,
    );
    if (!refresh) {
      this.logger.warn(
        { user_id: user.id, error_code: 'SESSIONS_CLOSED_DURING_SIGN_IN' },
        'sign-in refused: every session of the account was closed meanwhile',
      );
      throw new InvalidCredentialsError();
    }

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
      mfaEnabled: user.mfaEnabledAt !== null,
    };
  }

  /**
   * Roles the user currently holds, by id and site.
   *
   * Exposed so the controller can resolve them into permissions for the
   * client. The interface uses them to decide what to OFFER — never to decide
   * access, which the API settles on every request.
   */
  async grantsFor(userId: string) {
    return this.users.findActiveGrants(userId);
  }
}
