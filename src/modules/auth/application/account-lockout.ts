import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  AUTH_USER_REPOSITORY,
  type AuthUser,
  type AuthUserRepositoryPort,
} from './ports';

/**
 * AU-003. The brake that turns guessing into a bounded activity.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT IS ITS OWN COLLABORATOR AND NOT A PRIVATE METHOD OF `AuthService`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is what THREE flows share: the password (`AuthService.signIn`), the
 * second factor at sign-in, and the proof of the current factor AU-037 demands
 * before a re-enrolment. The alternative was a second copy of the backoff
 * arithmetic living beside the third one, and a lockout that is computed in two
 * places is a lockout that stops matching in one of them — which is not a
 * cosmetic drift: the path with the weaker counter is the path an attacker
 * picks.
 *
 * It stays in `application` and not in `domain` because it WRITES: the count
 * has to be produced by the database (see `registerFailure` on the port).
 */

/**
 * Lockout thresholds.
 *
 * Two layers on purpose: per account here, and per IP through the throttler.
 * Account-only lets an attacker lock a doctor out of the records deliberately
 * — a denial of service on patient care. IP-only does not stop distributed
 * credential stuffing.
 */
export const MAX_FAILED_ATTEMPTS = 5;
/**
 * Lower for the second factor: a six-digit code is not mistyped five times,
 * and the search space is 10^6 with three codes valid at once because of the
 * window. Sharing the password threshold would leave the SECOND factor easier
 * to brute-force than the first.
 */
export const MAX_MFA_ATTEMPTS = 3;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 15 * 60;

@Injectable()
export class AccountLockout {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountLockout.name);
  }

  /** Whether the account is serving a lockout right now. */
  isLocked(user: AuthUser): boolean {
    return user.lockedUntil !== null && user.lockedUntil > new Date();
  }

  /**
   * Counts a failure and locks the account once it crosses the threshold,
   * with capped exponential backoff — linear delays are trivial to wait out.
   *
   * The count comes back FROM the database. Computing it here from a value
   * read at the start of the request loses every concurrent attempt but one,
   * and an account that never reaches the threshold never locks.
   */
  async registerFailedAttempt(
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
