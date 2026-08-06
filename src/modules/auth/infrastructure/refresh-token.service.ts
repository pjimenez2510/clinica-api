import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  ClientContext,
  IssuedRefreshToken,
} from '../../../shared/request/client-context';
import { RevocationReason } from '../../../shared/request/client-context';

// Infrastructure THROWS domain errors; it does not DEFINE them. These two are
// part of the public contract, and an adapter defining public contract means
// changing the token strategy moves the contract with the frontend underneath.
import {
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from '../domain/auth.errors';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../../shared/config/env.schema';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { TokenService } from './token.service';

@Injectable()
export class RefreshTokenService {
  private readonly ttlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly logger: PinoLogger,
    config: ConfigService<Env, true>,
  ) {
    this.ttlDays = config.get('JWT_REFRESH_TTL_DAYS', { infer: true });
    this.logger.setContext(RefreshTokenService.name);
  }

  /** Starts a new session family. Called on sign-in, not on refresh. */
  async issueForNewSession(
    userId: string,
    ctx: ClientContext = {},
  ): Promise<IssuedRefreshToken> {
    return this.issue(userId, randomUUID(), ctx);
  }

  /**
   * Rotates a refresh token.
   *
   * THE SECURITY MECHANISM: every token can be used exactly once. If one that
   * has already been used arrives, somebody holds a copy — either the
   * legitimate user or the attacker, and there is no way to tell which. The
   * only safe response is to revoke the whole family and force a new sign-in.
   *
   * That is what turns a stolen token into an alarm instead of a silent breach:
   * without rotation, the thief refreshes forever and nothing ever shows up.
   */
  async rotate(
    presentedToken: string,
    ctx: ClientContext = {},
  ): Promise<IssuedRefreshToken> {
    const hash = TokenService.hashRefreshToken(presentedToken);

    /**
     * Atomic claim: only succeeds if the token is unused, unrevoked and not
     * expired. Doing "read, check, then write" instead would let two
     * simultaneous refreshes both succeed and split the family in two.
     */
    const claimed = await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: hash,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date(), revocationReason: RevocationReason.ROTATION },
    });

    if (claimed.count === 1) {
      const token = await this.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash },
        select: { userId: true, familyId: true },
      });
      return this.issue(token.userId, token.familyId, ctx);
    }

    // The claim failed. Find out whether this is an attack or just an
    // expired/unknown token.
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: { userId: true, familyId: true, usedAt: true },
    });

    if (existing?.usedAt) {
      await this.revokeFamily(existing.familyId, RevocationReason.REUSE);

      // High priority: this is a security incident, not a failed sign-in.
      // The security officer must review it.
      this.logger.error(
        {
          user_id: existing.userId,
          action: 'REFRESH_TOKEN_REUSE',
          error_code: 'REFRESH_TOKEN_REUSE_DETECTED',
        },
        'refresh token reuse detected, family revoked',
      );

      throw new RefreshTokenReuseError();
    }

    throw new InvalidRefreshTokenError();
  }

  /** Closes one session. The other sessions of the user stay open. */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
  }

  /** Closes every session. Used on password change and on account lockout. */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
  }

  /**
   * Deletes expired tokens.
   *
   * ⚠️ TODO: NOTHING CALLS THIS. `refresh_token` grows without bound. It needs
   * a scheduled job, which is what pg-boss is already a dependency for — but
   * the queue is not wired up yet, and claiming this "runs from a scheduled
   * job" while nothing runs it is worse than admitting it.
   *
   * Used tokens are NOT deleted before they expire: they are what makes reuse
   * detectable. Removing them early would turn an attack into a plain
   * "unknown token".
   */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }

  private async issue(
    userId: string,
    familyId: string,
    ctx: ClientContext,
  ): Promise<IssuedRefreshToken> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hash,
        expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 512),
      },
    });

    return { token, familyId, expiresAt };
  }
}
