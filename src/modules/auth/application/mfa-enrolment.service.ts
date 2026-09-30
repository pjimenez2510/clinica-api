import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  MfaAlreadyEnrolledError,
  MfaChangeNotStartedError,
  MfaNotEnrolledError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import { generateBackupCodes } from '../domain/backup-code';
import { SecondFactorVerifier } from './second-factor-verifier';
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
 * Enrolling a second factor — and replacing it — split out of `AuthService`.
 *
 * ADR-008 §2 applied to the letter: with nine public use cases AuthService had
 * crossed the ~8 ceiling, and these two were the separable group — they touch
 * only `users` and `totp`, never the lockout accounting or session issuance
 * the other seven share, and their reason to change (how a second factor is
 * set up) is not the session lifecycle. `verifyMfa` STAYS in AuthService on
 * the same criterion: it participates in lockout and issues the session.
 *
 * AU-037 added two more use cases here rather than anywhere else for that same
 * reason: changing a second factor is how one is set up, not how a session is
 * issued — and it deliberately issues none.
 */
@Injectable()
export class MfaEnrolmentService {
  constructor(
    @Inject(AUTH_USER_REPOSITORY)
    private readonly users: AuthUserRepositoryPort,
    /**
     * AU-005. The SAME hasher the password uses, and deliberately so: a backup
     * code is a credential a person types, not a machine-generated token, so
     * it gets Argon2id at the password parameters. `BackupCode.codeHash` in
     * `schema.prisma` says as much next to the column.
     */
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOTP) private readonly totp: TotpPort,
    /**
     * AU-037. The SAME verifier that completes a sign-in, and not a private
     * copy of it: the proof this service demands before a re-enrolment is the
     * identical question, and the two must not be able to answer differently.
     */
    private readonly secondFactor: SecondFactorVerifier,
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

  /**
   * Confirms enrolment: proves the user actually scanned the QR code, and
   * hands over the backup codes.
   *
   * AU-005 — THE BATCH IS RETURNED EXACTLY ONCE, HERE, AND NEVER AGAIN. Only
   * the Argon2 hashes are stored, so there is nowhere to read the codes back
   * from; this response is the single moment they exist outside the person's
   * hands. That is the same reasoning as `enroll` returning the plaintext
   * secret, and it is what makes the codes worth anything: a list the server
   * can re-read is a list a stolen database contains.
   */
  async confirm(
    userId: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(userId);

    if (!user.mfaSecretEncrypted) throw new MfaNotEnrolledError();
    // A cheap early exit only. It is NOT what stops a second confirmation —
    // this read cannot; see the claim below.
    if (user.mfaEnabledAt) throw new MfaAlreadyEnrolledError();

    const usedStep = this.totp.verify(
      user.mfaSecretEncrypted,
      code,
      user.email,
      null,
    );

    const { batch, hashes } = await this.mintBackupCodes();

    /**
     * ONE OPERATION, AND THE DATABASE DECIDES WHO CONFIRMED.
     *
     * Two things ride on this being a single call and not two.
     *
     * THE FACTOR AND THE CODES CANNOT COME APART. Enabling the second factor
     * and then failing to store the codes would leave an account with a factor
     * and no way to recover it — there is no endpoint to regenerate a batch —
     * which is precisely the lockout AU-005 exists to prevent. The reverse
     * leaves codes hanging off an account whose factor was never enabled,
     * which is merely useless. Neither survives here: the adapter commits both
     * or neither.
     *
     * AND THE «NOT YET ENROLLED» CONDITION IS NOT MINE TO EVALUATE. The read
     * above cannot enforce it: the form submitted twice — a double click, or
     * the client retrying — arrives with the SAME TOTP code, and confirmation
     * accepts it twice on purpose (it passes `null` as the last used step, so
     * there is nothing to replay against). Both requests would see an
     * unenrolled account, both would generate a batch, and the person would be
     * handed two different lists of ten. The condition travels with the write
     * and the answer comes back as a boolean; losing means somebody else
     * already confirmed, which is what `MfaAlreadyEnrolledError` says.
     */
    const enrolled = await this.users.confirmMfaWithBackupCodes(
      userId,
      usedStep,
      hashes,
    );
    if (!enrolled) throw new MfaAlreadyEnrolledError();

    this.logger.info(
      { user_id: userId, action: 'MFA_ENROLLED' },
      'second factor enrolled',
    );

    return { backupCodes: batch.map((backupCode) => backupCode.display) };
  }

  /**
   * AU-037. Starts a CHANGE of second factor, against a code from the current
   * one.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THE OLD SECRET IS NOT TOUCHED HERE, AND THAT IS THE REQUIREMENT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The obvious implementation — reuse `enroll`, overwrite the secret, clear
   * `mfaEnabledAt` — is the failure this use case exists to avoid. A person
   * who closes the tab between the QR code and the confirmation, or whose scan
   * fails, would be left with NO second factor and a session that cannot
   * enrol a new one without one. It is the same shape as the defect the
   * adversarial review found in AU-005 (the lost `mfa/confirm` response), and
   * here it is closed by writing the new secret to a field of its own.
   *
   * WHAT THE PROOF BUYS, and why this is safe where resetting your own factor
   * is not (`CannotResetOwnMfaError`): it demands POSSESSION OF THE VERY THING
   * BEING REPLACED. A stolen session cannot produce it, and whoever lost their
   * phone cannot either — they have AU-005's backup codes and, failing those,
   * AU-035.
   *
   * IT DOES NOT CLOSE ANY SESSION, unlike AU-035/AU-036. There is nobody to
   * distrust: the person has just proved they are themselves.
   */
  async startChange(
    userId: string,
    currentCode: string,
  ): Promise<{ secret: string; uri: string }> {
    const user = await this.requireUser(userId);

    // A CONFIRMED factor, not merely a stored secret. An enrolment left
    // half-done has nothing to prove possession of, and the way forward there
    // is `confirm`, not this.
    if (!user.mfaEnabledAt || !user.mfaSecretEncrypted) {
      throw new MfaNotEnrolledError();
    }

    /**
     * THE PROOF, AND EVERYTHING IT DRAGS WITH IT. A TOTP or a backup code —
     * which is SPENT, like any other use of one. A failure counts towards the
     * same lockout as any other second-factor failure (AU-003), and the
     * refusal is the SAME one a wrong TOTP produces at sign-in, so this route
     * cannot become the oracle for «does this account have live backup codes»
     * that `mfa/verify` refuses to be.
     *
     * It throws before anything is generated or written.
     */
    await this.secondFactor.verify(user, currentCode);

    const { secret, encrypted, uri } = this.totp.enroll(user.email);
    // The PENDING field. Not `savePendingMfaSecret`, which is the first
    // enrolment and would retire the working factor right here.
    await this.users.savePendingMfaChange(userId, encrypted);

    return { secret, uri };
  }

  /**
   * AU-037. Confirms the new authenticator: swaps the secret and hands over a
   * brand-new batch of backup codes, invalidating the old one.
   *
   * THE OLD BATCH GOES WITH THE OLD SECRET. A person changing phones has the
   * previous ten codes written on paper somewhere, and those codes open an
   * account whose factor they have just replaced — which is exactly the state
   * `confirmMfaWithBackupCodes` documents as unacceptable for AU-005. Both
   * halves land in one operation or neither does.
   */
  async confirmChange(
    userId: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(userId);

    const pending = user.mfaPendingSecretEncrypted;
    // A cheap early exit only. What actually arbitrates two confirmations is
    // the claim below, which this read cannot make.
    if (!pending) throw new MfaChangeNotStartedError();

    /**
     * VERIFIED AGAINST THE PENDING SECRET, AND WITH NO LAST USED STEP.
     *
     * `null` and not `user.mfaLastStep`, because a step belongs to a SECRET
     * and not to an account. The stored one was consumed moments ago by the
     * proof against the OLD secret, and the new authenticator is generating
     * codes for the very same wall-clock step — so passing it would refuse a
     * perfectly good code and make the change impossible for thirty seconds
     * with nothing on screen to explain why.
     *
     * That leaves the same code able to confirm twice, exactly as in
     * `confirm`, and exactly as there it is the atomic claim below that stops
     * the second one — not this argument.
     */
    const usedStep = this.totp.verify(pending, code, user.email, null);

    const { batch, hashes } = await this.mintBackupCodes();

    const replaced = await this.users.replaceMfaSecretWithBackupCodes(
      userId,
      pending,
      usedStep,
      hashes,
    );
    // Losing means somebody already confirmed this change, or started another
    // one. Handing over ten codes that were never stored would leave the
    // person copying down a list that opens nothing.
    if (!replaced) throw new MfaChangeNotStartedError();

    this.logger.info(
      { user_id: userId, action: 'MFA_CHANGED' },
      'second factor replaced by its holder',
    );

    return { backupCodes: batch.map((backupCode) => backupCode.display) };
  }

  /**
   * A fresh batch and its hashes. Shared by the two confirmations so that the
   * count, the alphabet and — above all — hashing the CANONICAL form cannot
   * drift apart: a batch hashed with the hyphen is a batch that is refused
   * when it is typed back.
   */
  private async mintBackupCodes(): Promise<{
    batch: ReturnType<typeof generateBackupCodes>;
    hashes: string[];
  }> {
    const batch = generateBackupCodes();
    // Hashed in the CANONICAL form — no hyphen — because that is what a
    // presented code normalises to when somebody types it back.
    const hashes = await Promise.all(
      batch.map((backupCode) => this.hasher.hash(backupCode.canonical)),
    );
    return { batch, hashes };
  }

  /**
   * Same rule as `AuthService.requireUser`: a vanished account behind a valid
   * token is an invalid session (401), not a missing resource.
   */
  private async requireUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new SessionUserMissingError();
    return user;
  }
}
