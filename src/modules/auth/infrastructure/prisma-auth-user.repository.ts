import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { AuthUser, AuthUserRepositoryPort } from '../application/ports';
import type { RoleAssignment } from '../domain/principal';

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
  mfaEnabledAt: true,
  mfaLastStep: true,
  failedAttempts: true,
  lockedUntil: true,
} as const;

@Injectable()
export class PrismaAuthUserRepository implements AuthUserRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: AUTH_USER_FIELDS,
    });
  }

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

  async confirmMfa(userId: string, usedStep: bigint): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: new Date(), mfaLastStep: usedStep },
    });
  }

  async recordMfaStep(userId: string, usedStep: bigint): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaLastStep: usedStep },
    });
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
