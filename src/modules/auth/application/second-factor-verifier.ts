import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  InvalidMfaCodeError,
  MfaNotEnrolledError,
} from '../domain/auth.errors';
import { BACKUP_CODE_COUNT, normalizeBackupCode } from '../domain/backup-code';

import { AccountLockout, MAX_MFA_ATTEMPTS } from './account-lockout';
import {
  AUTH_USER_REPOSITORY,
  type AuthUser,
  type AuthUserRepositoryPort,
  PASSWORD_HASHER,
  type PasswordHasherPort,
  TOTP,
  type TotpPort,
} from './ports';

/**
 * How the presented value turned out to be a valid second factor.
 *
 * Returned rather than discarded because the two are not interchangeable to
 * the caller: a backup code means the person has lost their authenticator, and
 * a TOTP carries the time step that was consumed.
 */
export type SecondFactorProof =
  | { readonly kind: 'totp'; readonly usedStep: bigint }
  | { readonly kind: 'backup-code' };

/**
 * «Is this the second factor of this account?», in one place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT WAS LIFTED OUT OF `AuthService.verifyMfa`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AU-037 asks the SAME question at a completely different moment: before
 * letting somebody with a full session re-enrol, they must present a code from
 * the factor they are about to replace. That is not «similar to» completing a
 * sign-in — it is the identical problem, down to every detail that took a
 * review to get right: the backup code accepted alongside the TOTP, the
 * padding that stops the response timing from saying whether the account has
 * live codes, the failure counted towards the same lockout, and the refusal
 * being the error the TOTP verifier raised and never one of its own.
 *
 * A second copy would have drifted from all four. It is the first three that
 * matter least: the one that would have hurt is the fourth, because a distinct
 * answer on the re-enrolment path would have re-opened the enumeration AU-002
 * closes — this time to a caller who is already authenticated but not
 * necessarily as the account holder.
 *
 * WHAT IT DOES NOT DO: issue a session, and decide what the proof unlocks.
 * Those belong to whoever asked. This only answers the question, counts the
 * failure and records the step.
 */
@Injectable()
export class SecondFactorVerifier {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOTP) private readonly totp: TotpPort,
    private readonly lockout: AccountLockout,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SecondFactorVerifier.name);
  }

  /**
   * AU-005, AU-037. Verifies a TOTP code or spends a backup code.
   *
   * Throws — with the SAME error in both cases — when neither works, having
   * counted the attempt towards the lockout first.
   */
  async verify(user: AuthUser, code: string): Promise<SecondFactorProof> {
    /**
     * The second factor gets the same brake as the first.
     *
     * Without this, a wrong code cost nothing: no counter, no lock, no record.
     * The only limit was the per-IP throttle, and the challenge token stays
     * valid for the full fifteen minutes — so rotating addresses was enough to
     * walk 10^6 codes, with three of them valid at any moment. The second
     * factor was the weaker one.
     */
    if (this.lockout.isLocked(user)) {
      this.logger.warn(
        { user_id: user.id, error_code: 'ACCOUNT_LOCKED' },
        'second factor verification denied',
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
      /**
       * AU-005 — the authenticator refused it, so it may be a backup code.
       *
       * ⚠️ THE FAILURE ANSWERS WITH THE ERROR THE TOTP VERIFIER RAISED, not
       * with one of its own. The same status, the same code, the same
       * sentence: a distinct answer for "that is not a valid backup code"
       * would tell the caller whether the account has live codes, which is the
       * same enumeration `InvalidCredentialsError` refuses to do one factor
       * earlier.
       *
       * AND IT COUNTS THE SAME. A backup code carries 50 bits against the
       * TOTP's 20, but a path with no lockout is the path an attacker picks
       * regardless of its width — and this one, unlike the TOTP, does not
       * expire every thirty seconds.
       */
      if (await this.spendBackupCode(user.id, code)) {
        await this.users.clearFailedAttempts(user.id);
        // Logged because it is worth noticing: a person using a backup code
        // has lost their authenticator, and somebody has to issue a new one.
        this.logger.warn(
          { user_id: user.id, action: 'MFA_BACKUP_CODE_USED' },
          'second factor satisfied with a backup code',
        );
        return { kind: 'backup-code' };
      }

      await this.lockout.registerFailedAttempt(user.id, MAX_MFA_ATTEMPTS);
      throw error;
    }

    await this.users.clearFailedAttempts(user.id);

    // Persisting the step is what makes replay detection work. Without it the
    // code stays usable for its whole 30 second window.
    await this.users.recordMfaStep(user.id, usedStep);

    return { kind: 'totp', usedStep };
  }

  /**
   * AU-005. Tries the presented value against the account's live backup codes
   * and spends the one that matches. True only if THIS call spent it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS COSTS, AND WHY IT IS SHAPED LIKE THIS.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The stored hash is Argon2id and Argon2id is SALTED, so there is nothing to
   * look up: the presented code has to be verified against each live hash in
   * turn. At the password parameters (19 MiB, t=2) that is ~50 ms per attempt,
   * so a failure costs `BACKUP_CODE_COUNT` of them — about half a second — and
   * a success costs half that on average, stopping at the match.
   *
   * Two things keep that bounded, and both are load-bearing:
   *
   *   1. THE SHAPE GATE. A value that is not shaped like a backup code never
   *      reaches the loop, so a mistyped six-digit TOTP costs nothing extra.
   *      The decision looks only at what the CALLER SENT — never at anything
   *      about the account — so it cannot leak.
   *   2. THE LOCKOUT. Three failures lock the account, and the route is
   *      throttled per IP, so nobody gets to spend this CPU indefinitely.
   *
   * THE PADDING IS NOT DECORATION. Without it the work done depends on how
   * many live codes the account has — zero verifications versus ten, half a
   * second apart — and that is a readable answer to "does this person have
   * backup codes", asked by anyone who can reach the endpoint. Unifying the
   * RESPONSE does not close a gap that wide. Every failure therefore spends
   * exactly `BACKUP_CODE_COUNT` Argon2 operations, whatever the account holds.
   */
  private async spendBackupCode(
    userId: string,
    presented: string,
  ): Promise<boolean> {
    const canonical = normalizeBackupCode(presented);
    if (!canonical) return false;

    const live = await this.users.findLiveBackupCodes(userId);

    /**
     * AT MOST ONE BATCH IS EVER TRIED, AND THE CAP IS DEFENSIVE.
     *
     * Nothing in the database bounds how many live rows an account can hold:
     * `backup_code` carries a primary key, a foreign key and an index on
     * `(user_id, used_at)`, and no constraint on the count. Taking the batch
     * size on trust here is what makes the padding below a lie — with twenty
     * live rows the loop costs twenty verifications, the padding never runs,
     * and that account answers in twice the time every other account takes.
     * A latency difference that wide IS the oracle the padding exists to
     * close, so the work is capped whatever the rows say.
     *
     * Oldest first (the repository orders it so), which is the order a batch
     * is meant to be spent in.
     */
    const candidates = live.slice(0, BACKUP_CODE_COUNT);

    for (const candidate of candidates) {
      if (await this.hasher.verify(candidate.codeHash, canonical)) {
        // Whether it is actually spent is the DATABASE's answer: two requests
        // arriving with the same code both get here, and only one may win.
        // Losing reads exactly like a code that was already used, which is
        // what it now is.
        return this.users.consumeBackupCode(candidate.id);
      }
    }

    for (let spent = candidates.length; spent < BACKUP_CODE_COUNT; spent += 1) {
      await this.hasher.burnTime();
    }

    return false;
  }
}
