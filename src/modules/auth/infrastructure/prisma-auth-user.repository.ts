import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { AuthUser, AuthUserRepositoryPort } from '../application/ports';

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

  async recordFailedAttempt(
    userId: string,
    failures: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: failures, lockedUntil },
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
}
