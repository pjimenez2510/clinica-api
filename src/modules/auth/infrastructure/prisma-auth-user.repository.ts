import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  AuthUser,
  AuthUserRepositoryPort,
  LiveBackupCode,
} from '../application/ports';
import type { RoleAssignment } from '../../../shared/authorisation/principal';

/**
 * Only the columns the use cases actually need are selected.
 *
 * Not `SELECT *`: Prisma returns every column when you omit `select`, and this
 * table will grow fields that have no business travelling through the auth
 * flow. Being explicit also means a new column cannot leak into a log by
 * accident.
 */
const AUTH_USER_FIELDS = {
  id: true,
  email: true,
  passwordHash: true,
  firstName: true,
  lastName: true,
  cedula: true,
  active: true,
  mfaSecretEncrypted: true,
  mfaPendingSecretEncrypted: true,
  mfaEnabledAt: true,
  mfaLastStep: true,
  failedAttempts: true,
  lockedUntil: true,
} as const;

/**
 * Prisma adapter for the session half's `AuthUserRepositoryPort`. Every read
 * goes through `AUTH_USER_FIELDS`, so a new column never reaches the auth flow
 * by accident.
 */
@Injectable()
export class PrismaAuthUserRepository implements AuthUserRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `null` for an unknown address: `AuthService.signIn` then burns the same CPU
   * as a real verification before refusing (AU-002).
   */
  async findByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: AUTH_USER_FIELDS,
    });
  }

  /**
   * `null` when the account is gone; the callers turn that into
   * `SessionUserMissingError`.
   */
  async findById(id: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: AUTH_USER_FIELDS,
    });
  }

  /** Resolves the owner of a session family after a refresh rotation. */
  async findByRefreshFamily(familyId: string): Promise<AuthUser | null> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { familyId },
      orderBy: { createdAt: 'desc' },
      select: { user: { select: AUTH_USER_FIELDS } },
    });
    return row?.user ?? null;
  }

  /**
   * The transparent rehash after a successful sign-in, when `needsRehash` says
   * the parameters are outdated. Sessions are untouched: the password itself
   * did not change.
   */
  async updatePasswordHash(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  /**
   * `increment`, not an absolute value.
   *
   * The previous version read the counter into the process and wrote back
   * `read + 1`. Twenty concurrent attempts all read 0 and all wrote 1, so
   * `failedAttempts` never reached the threshold and the account never locked
   * — leaving only the per-IP throttle, which is exactly what a distributed
   * attack sidesteps.
   */
  async registerFailure(userId: string): Promise<number> {
    const { failedAttempts } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    return failedAttempts;
  }

  /**
   * AU-003. The instant comes from `AccountLockout`, which owns the backoff
   * arithmetic; this only writes it.
   */
  async applyLock(userId: string, lockedUntil: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lockedUntil },
    });
  }

  /**
   * Both writes or neither.
   *
   * The transaction lives here because it is a detail of this adapter. What
   * the port declares is the atomicity: a password changed without the
   * sessions being cut is the precise situation the operation exists to
   * prevent.
   */
  async rotateCredentials(
    userId: string,
    passwordHash: string,
    revocationReason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason },
      });
    });
  }

  /**
   * Resets the counter and lifts any lock together, so a successful proof
   * leaves no stale partial count behind.
   */
  async clearFailedAttempts(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  /** Stores the secret but leaves it disabled until it is confirmed. */
  async savePendingMfaSecret(
    userId: string,
    encryptedSecret: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaSecretEncrypted: encryptedSecret,
        mfaEnabledAt: null,
        mfaLastStep: null,
      },
    });
  }

  /**
   * The step `TotpService.verify` just consumed. Persisting it is what makes a
   * replayed code within its 30-second window fail.
   */
  async recordMfaStep(userId: string, usedStep: bigint): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaLastStep: usedStep },
    });
  }

  /**
   * AU-005. Enables the factor and installs the batch, or does neither — and
   * `count` is the answer to "was it me?".
   *
   * THE CLAIM COMES FIRST, INSIDE THE TRANSACTION, AND THAT ORDER IS THE
   * WHOLE ARBITRATION. `WHERE id = ? AND mfa_enabled_at IS NULL` is evaluated
   * by PostgreSQL in the same statement that writes, so the winner takes the
   * user row lock and holds it until it commits. A second confirmation of the
   * same account — the double-clicked form, arriving with the same TOTP code
   * inside the same thirty-second window — blocks there, re-reads the row
   * under READ COMMITTED once the first commits, finds `mfa_enabled_at` set
   * and updates nothing. It therefore never reaches the batch, which is the
   * point: two callers past this line would each delete the rows they could
   * see and insert ten of their own, leaving TWENTY live codes and a person
   * holding two lists with no way to tell which one works.
   *
   * ONE TRANSACTION, because the gap between the statements is an account with
   * a second factor and no usable backup code at all. Short, but it is the
   * window in which the person who just lost their phone is told to write down
   * ten codes that do not exist.
   */
  async confirmMfaWithBackupCodes(
    userId: string,
    usedStep: bigint,
    codeHashes: readonly string[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, mfaEnabledAt: null },
        data: { mfaEnabledAt: new Date(), mfaLastStep: usedStep },
      });
      if (count !== 1) return false;

      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      });

      return true;
    });
  }

  /**
   * AU-037. The secret of a change in progress, and NOTHING else.
   *
   * Every other field is deliberately absent from this `data`. The temptation
   * is to mirror `savePendingMfaSecret` and clear `mfaEnabledAt` "for
   * symmetry"; doing so is what would strand somebody halfway through changing
   * their phone with no second factor at all.
   */
  async savePendingMfaChange(
    userId: string,
    encryptedSecret: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecretEncrypted: encryptedSecret },
    });
  }

  /**
   * AU-037. Installs the pending secret as the real one and replaces the batch
   * — or does neither — and `count` is the answer to "was it me?".
   *
   * THE CLAIM IS `mfa_pending_secret_encrypted = <this exact blob>`, EVALUATED
   * BY POSTGRESQL IN THE STATEMENT THAT WRITES. `mfa_enabled_at IS NULL`, the
   * condition that arbitrates a first enrolment, is useless here: the account
   * IS enrolled, so it would match every caller and settle nothing.
   *
   * The winner takes the user row lock and nulls the pending secret. A second
   * confirmation of the same change — the double-clicked form, carrying the
   * same TOTP code inside the same thirty-second window — blocks, re-reads
   * under READ COMMITTED, matches nothing and updates nothing. Two callers
   * past this line would each delete the rows they could see and insert ten of
   * their own, leaving TWENTY live codes and a person holding two lists.
   *
   * Matching the EXACT blob rather than `IS NOT NULL` also decides the other
   * race: a change started twice. The confirmation belonging to the abandoned
   * secret loses, instead of installing a secret whose QR code that person may
   * never have scanned.
   *
   * ONE TRANSACTION, because the gap between the statements is an account
   * whose factor has just changed and whose backup codes are still the old
   * batch — the one printed on the paper the person believes they have just
   * replaced.
   */
  async replaceMfaSecretWithBackupCodes(
    userId: string,
    pendingSecretEncrypted: string,
    usedStep: bigint,
    codeHashes: readonly string[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          mfaPendingSecretEncrypted: pendingSecretEncrypted,
        },
        data: {
          mfaSecretEncrypted: pendingSecretEncrypted,
          mfaPendingSecretEncrypted: null,
          // The factor is enabled again, now: to an auditor the date answers
          // "since when is THIS device the second factor", and the old answer
          // stopped being true the moment the secret changed.
          mfaEnabledAt: new Date(),
          mfaLastStep: usedStep,
        },
      });
      if (count !== 1) return false;

      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      });

      return true;
    });
  }

  /** Unspent codes only. The filter is in the QUERY: see the port. */
  async findLiveBackupCodes(userId: string): Promise<LiveBackupCode[]> {
    return this.prisma.backupCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
      // Oldest first, so a batch is spent in the order it was printed.
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * AU-005. A CONDITIONAL update, and that is the single-use guarantee.
   *
   * `WHERE id = ? AND used_at IS NULL` is evaluated by PostgreSQL in the same
   * statement that writes. Two requests carrying the same code both find the
   * row unused and both get here; the first takes the row lock and writes, the
   * second blocks, re-reads the row under READ COMMITTED, finds `used_at` set
   * and updates nothing. `count` is therefore the answer to "was it me?", and
   * exactly one caller can hear yes.
   *
   * The same shape as the refresh token claim, for the same reason: a "read,
   * check, write" in the application would let both through and hand the same
   * code two sessions.
   */
  async consumeBackupCode(backupCodeId: string): Promise<boolean> {
    const { count } = await this.prisma.backupCode.updateMany({
      where: { id: backupCodeId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Roles in force right now.
   *
   * Revoked grants are filtered in the QUERY, not afterwards: a filter that
   * lives in application code is one someone can forget to apply, and the
   * consequence here is a revoked role still granting clinical access.
   *
   * Only the ROLE ID travels. Which permissions it carries is resolved per
   * request, so an administrator revoking one takes effect without waiting for
   * every live token to expire.
   */
  async findActiveGrants(userId: string): Promise<RoleAssignment[]> {
    const grants = await this.prisma.userRoleGrant.findMany({
      where: { userId, revokedAt: null },
      select: { roleId: true, siteId: true },
    });
    return grants.map((grant) => ({
      roleId: grant.roleId,
      siteId: grant.siteId,
    }));
  }
}
