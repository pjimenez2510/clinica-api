import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  MfaAlreadyEnrolledError,
  MfaNotEnrolledError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import {
  AUTH_USER_REPOSITORY,
  type AuthUser,
  type AuthUserRepositoryPort,
  TOTP,
  type TotpPort,
} from './ports';

/**
 * Enrolling a second factor, split out of `AuthService`.
 *
 * ADR-008 §2 applied to the letter: with nine public use cases AuthService had
 * crossed the ~8 ceiling, and these two were the separable group — they touch
 * only `users` and `totp`, never the lockout accounting or session issuance
 * the other seven share, and their reason to change (how a second factor is
 * set up) is not the session lifecycle. `verifyMfa` STAYS in AuthService on
 * the same criterion: it participates in lockout and issues the session.
 */
@Injectable()
export class MfaEnrolmentService {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    @Inject(TOTP) private readonly totp: TotpPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MfaEnrolmentService.name);
  }

  /**
   * Starts enrolment: generates the secret and stores it as PENDING.
   *
   * Keeping the pending secret server-side rather than handing the encrypted
   * blob to the client removes a whole class of replay: the client never holds
   * anything it could send back later.
   *
   * The plaintext secret is returned exactly once, for the QR code.
   */
  async enroll(userId: string): Promise<{ secret: string; uri: string }> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabledAt) throw new MfaAlreadyEnrolledError();

    const { secret, encrypted, uri } = this.totp.enroll(user.email);
    await this.users.savePendingMfaSecret(userId, encrypted);

    return { secret, uri };
  }

  /** Confirms enrolment: proves the user actually scanned the QR code. */
  async confirm(userId: string, code: string): Promise<void> {
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

  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new SessionUserMissingError();
    return user;
  }
}
