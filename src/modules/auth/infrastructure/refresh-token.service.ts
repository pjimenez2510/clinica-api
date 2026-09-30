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
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../../shared/config/env.schema';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { TokenService } from './token.service';

/** The service's own client, or the transaction a write must join. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * AU-004, AU-036, AU-039. The refresh-token registry: families, single-use
 * rotation, reuse detection with its grace window, and the per-request «is
 * this session still open?» the JWT guard asks. Only SHA-256 hashes are stored
 * (see `TokenService.hashRefreshToken`).
 */
@Injectable()
export class RefreshTokenService {
  private readonly ttlDays: number;
  private readonly graceSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly logger: PinoLogger,
    config: ConfigService<Env, true>,
  ) {
    this.ttlDays = config.get('JWT_REFRESH_TTL_DAYS', { infer: true });
    this.graceSeconds = config.get('JWT_REFRESH_REUSE_GRACE_SECONDS', {
      infer: true,
    });
    this.logger.setContext(RefreshTokenService.name);
  }

  /** Starts a new session family. Called on sign-in, not on refresh. */
  async issueForNewSession(
    userId: string,
    ctx: ClientContext = {},
  ): Promise<IssuedRefreshToken> {
    return this.issue(this.prisma, userId, randomUUID(), ctx);
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
     *
     * Claim and successor in ONE transaction. Apart, a revocation committed
     * between them left the successor alive in a revoked family — and the
     * guard of AU-036 reads «a live row» as «the session is open». Held
     * together, the claim's row lock makes a concurrent `revokeFamily` wait
     * for the successor and then see it (see `revokeFamily`).
     */
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: {
          tokenHash: hash,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          usedAt: new Date(),
          revocationReason: RevocationReason.ROTATION,
        },
      });
      if (claimed.count !== 1) return null;

      const token = await tx.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash },
        select: { userId: true, familyId: true },
      });
      return this.issue(tx, token.userId, token.familyId, ctx);
    });
    if (rotated) return rotated;

    // AU-039: the response carrying the successor may simply never have
    // arrived. Only if every condition holds; otherwise it is AU-004.
    const regranted = await this.reissueWithinGrace(hash, ctx);
    if (regranted) return regranted;

    // The claim failed. Find out whether this is an attack or just an
    // expired/unknown token.
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: {
        userId: true,
        familyId: true,
        usedAt: true,
        revocationReason: true,
      },
    });

    /**
     * Two ways a token proves somebody else holds a copy: it was already
     * spent, or it is the successor AU-039 withdrew — whose response, it turns
     * out, did reach somebody. Either way there are two holders of one session.
     */
    const reused =
      existing?.usedAt != null ||
      existing?.revocationReason === RevocationReason.SUPERSEDED;

    if (existing && reused) {
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

  /**
   * AU-039. Re-issues the session when the token just rotated comes back
   * because its response was lost; `null` when any condition fails.
   *
   * THE FOUR CONDITIONS, in one locking statement so none of them can change
   * between checking and issuing:
   *   - used within the last `graceSeconds` — measured from the FIRST use,
   *     which is never moved, so repeating the token cannot stretch the window;
   *   - its family still open (`revoked_at IS NULL` on this row: every
   *     revocation writes it on every live row of the family);
   *   - the LAST used token of its family: if its successor was used, the
   *     response did arrive and the session moved on (Auth0: «only the
   *     previous token can be reused»);
   *   - presented by the same user agent that received it.
   *
   * THE ORPHAN IS WITHDRAWN. Because the presented token is the last used one,
   * every unused, unrevoked row of the family is one of its successors — the
   * one whose response was lost, and any earlier re-issue. Leaving them alive
   * would split the family into branches that never present a spent token
   * again, and reuse detection would never fire. The new row is inserted
   * BEFORE they are withdrawn, inside the transaction, so `isFamilyOpen` never
   * sees the family without a live row.
   */
  private async reissueWithinGrace(
    hash: string,
    ctx: ClientContext,
  ): Promise<IssuedRefreshToken | null> {
    const userAgent = ctx.userAgent?.slice(0, 512);
    if (this.graceSeconds === 0 || !userAgent) return null;

    const now = new Date();
    const usedSince = new Date(now.getTime() - this.graceSeconds * 1000);

    return this.prisma.$transaction(async (tx) => {
      const [presented] = await tx.$queryRaw<
        { user_id: string; family_id: string }[]
      >`
        SELECT t.user_id, t.family_id
          FROM refresh_token t
         WHERE t.token_hash = ${hash}
           AND t.used_at >= ${usedSince}
           AND t.revoked_at IS NULL
           AND t.expires_at > ${now}
           AND t.user_agent = ${userAgent}
           AND NOT EXISTS (
                 SELECT 1
                   FROM refresh_token later
                  WHERE later.family_id = t.family_id
                    AND later.used_at > t.used_at)
           FOR UPDATE OF t`;
      if (!presented) return null;

      const issued = await this.issue(
        tx,
        presented.user_id,
        presented.family_id,
        ctx,
      );
      await tx.refreshToken.updateMany({
        where: {
          familyId: presented.family_id,
          usedAt: null,
          revokedAt: null,
          tokenHash: { not: TokenService.hashRefreshToken(issued.token) },
        },
        data: { revokedAt: now, revocationReason: RevocationReason.SUPERSEDED },
      });

      // Not an incident, but worth seeing: a burst of these for one account
      // is either a very bad network or somebody racing its owner.
      this.logger.warn(
        { user_id: presented.user_id, action: 'REFRESH_TOKEN_REUSE_GRACE' },
        'spent refresh token re-presented within the grace window, session re-issued',
      );
      return issued;
    });
  }

  /**
   * AU-036. Is this session family still open?
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IT IS FOR, AND WHY THE ACCESS TOKEN NEEDS IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * An access token is self-contained: once signed, nothing about it can be
   * withdrawn before it expires. Every revocation in this file therefore closed
   * only half of a session — the refresh chain — and left up to a full
   * `JWT_ACCESS_TTL` of complete access alive. `JwtAuthGuard` asks this on
   * every authenticated request so the other half closes too.
   *
   * ONE INDEXED LOOKUP (`refresh_token_family_id_idx`), AND IT IS THE PRICE.
   * The alternative that avoids the query — an instant on `app_user` compared
   * against the token's `iat` — costs the same lookup on another table, plus a
   * column that EVERY future path which closes sessions has to remember to
   * bump. This derives from the fact that already exists and that every one of
   * those paths already writes: the family is revoked.
   *
   * A ROW WITH `revoked_at IS NULL` IS WHAT «OPEN» MEANS, and used rows count.
   * Rotation marks `used_at` and leaves `revoked_at` alone precisely so reuse
   * stays detectable, so requiring an unused row would kill the session of
   * anybody whose client refreshed while a request was in flight.
   */
  async isFamilyOpen(familyId: string): Promise<boolean> {
    const open = await this.prisma.refreshToken.findFirst({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });
    return open !== null;
  }

  /**
   * Closes one session. The other sessions of the user stay open.
   *
   * LOCK FIRST, WRITE AFTER, in two statements. A single `UPDATE` reads the
   * family from the snapshot it started with: if a rotation or an AU-039
   * re-issue was committing its successor meanwhile, the update waited on the
   * presented row and then revoked it — but never saw the successor, which
   * stayed alive and kept the session open. Locking the live rows makes this
   * wait for that transaction; the `UPDATE` then starts with a fresh snapshot
   * that includes whatever it committed. `ORDER BY created_at` locks in the
   * same order the re-issue does (the presented token, then its successors),
   * so the two cannot deadlock.
   */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM refresh_token
         WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL
         ORDER BY created_at, id
           FOR UPDATE`;
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: reason },
      });
    });
  }

  /**
   * Closes every session. Used on password change, deactivation (AU-023) and
   * second-factor reset (AU-036). Locks before writing, for the reason given
   * on `revokeFamily`.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM refresh_token
         WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
         ORDER BY created_at, id
           FOR UPDATE`;
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: reason },
      });
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

  /**
   * One refresh row in the family: only the hash is stored, and the user agent
   * is cut to 512 characters before it reaches the column. `db` is the
   * transaction of the rotation that issues it, so both commit together.
   */
  private async issue(
    db: Db,
    userId: string,
    familyId: string,
    ctx: ClientContext,
  ): Promise<IssuedRefreshToken> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);

    await db.refreshToken.create({
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
