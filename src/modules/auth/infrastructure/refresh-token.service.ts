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
  SessionExpiredError,
} from '../domain/auth.errors';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import type { Env } from '../../../shared/config/env.schema';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { lockLiveSessions, revokeLiveSessions } from './session-revocation';
import { TokenService } from './token.service';

/** The service's own client, or the transaction a write must join. */
type Db = PrismaService | Prisma.TransactionClient;

/** What the JWT guard needs to know about a session family (AU-036, AU-040). */
export type FamilyState = 'open' | 'revoked' | 'expired';

/**
 * AU-004, AU-036, AU-039, AU-040. The refresh-token registry: families,
 * single-use rotation, reuse detection with its grace window, the lifetime
 * ceiling of a family, and the per-request «is this session still open?» the
 * JWT guard asks. Only SHA-256 hashes are stored (see
 * `TokenService.hashRefreshToken`).
 *
 * AU-040: A FAMILY EXPIRES ONCE. Its expiry is fixed at sign-in and every
 * successor INHERITS it — a normal rotation and an AU-039 re-issue alike.
 * Before, each rotation set `now + JWT_REFRESH_TTL_DAYS` and a session used
 * every day never expired. No column is needed: the claim and the grace
 * already demand `expires_at > now`, so an expired family cannot renew by
 * construction.
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

  /**
   * Starts a new session family, and with it the instant the family expires
   * (AU-040). Called on sign-in, not on refresh.
   */
  async issueForNewSession(
    userId: string,
    ctx: ClientContext = {},
  ): Promise<IssuedRefreshToken> {
    const expiresAt = new Date(Date.now() + this.ttlDays * 24 * 60 * 60 * 1000);
    return this.issue(this.prisma, userId, randomUUID(), expiresAt, ctx);
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
        select: { userId: true, familyId: true, expiresAt: true },
      });
      // AU-040: the successor inherits the family's expiry, never extends it.
      return this.issue(tx, token.userId, token.familyId, token.expiresAt, ctx);
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
        expiresAt: true,
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

    /**
     * AU-040. The family ran out: every row shares this expiry. Nothing is
     * revoked and no alarm is raised even for a spent token — there is nothing
     * open left to take over, and the high-priority alarm for it would teach
     * the security officer to ignore that alarm. A spent one is still worth a
     * line, like `REFRESH_TOKEN_AFTER_CLOSE`.
     */
    if (existing && existing.expiresAt <= new Date()) {
      if (reused) {
        this.logger.warn(
          {
            user_id: existing.userId,
            family_id: existing.familyId,
            action: 'REFRESH_TOKEN_AFTER_EXPIRY',
          },
          'spent refresh token of an expired session presented',
        );
      }
      throw new SessionExpiredError();
    }

    if (existing && reused) {
      const stillOpen = await this.prisma.$transaction((tx) =>
        revokeLiveSessions(
          tx,
          { familyId: existing.familyId },
          RevocationReason.REUSE,
        ),
      );

      if (stillOpen > 0) {
        // High priority: this is a security incident, not a failed sign-in.
        // The security officer must review it.
        this.logger.error(
          {
            user_id: existing.userId,
            family_id: existing.familyId,
            action: 'REFRESH_TOKEN_REUSE',
            error_code: 'REFRESH_TOKEN_REUSE_DETECTED',
          },
          'refresh token reuse detected, family revoked',
        );
      } else {
        // The session was already closed — signed out, password changed, or
        // an earlier incident. Nothing was open to take over, and raising the
        // high-priority alarm for it would teach the security officer to
        // ignore that alarm. Same answer to the client either way.
        this.logger.warn(
          {
            user_id: existing.userId,
            family_id: existing.familyId,
            action: 'REFRESH_TOKEN_AFTER_CLOSE',
          },
          'spent refresh token of an already closed session presented',
        );
      }

      throw new RefreshTokenReuseError();
    }

    throw new InvalidRefreshTokenError();
  }

  /**
   * AU-039. Re-issues the session when the token just rotated comes back
   * because its response was lost; `null` when any condition fails.
   *
   * THE FAMILY IS LOCKED BEFORE ANYTHING IS CHECKED. The conditions are then
   * read by a NEW statement, whose snapshot already includes whatever a
   * concurrent rotation or revocation committed while this waited. Locking
   * only the presented row was not enough (clean-context review, 30-09-2026):
   * a rotation of its successor, in flight, was still invisible to the check,
   * the successor looked unused, and the family ended with two live heads.
   * Same lock order as every revocation (`lockLiveSessions`), so no deadlock.
   *
   * THE FOUR CONDITIONS:
   *   - used within the last `graceSeconds` — measured from the FIRST use,
   *     which is never moved, so repeating the token cannot stretch the window;
   *   - its family still open (`revoked_at IS NULL` on this row: every
   *     revocation writes it on every live row of the family);
   *   - the LAST used token of its family: if a token issued after it was
   *     used, the response did arrive and the session moved on (Auth0: «only
   *     the previous token can be reused»);
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

    return this.prisma.$transaction(async (tx) => {
      const known = await tx.refreshToken.findUnique({
        where: { tokenHash: hash },
        select: { familyId: true },
      });
      if (!known) return null;

      await lockLiveSessions(tx, { familyId: known.familyId });

      const now = new Date();
      const usedSince = new Date(now.getTime() - this.graceSeconds * 1000);
      const [presented] = await tx.$queryRaw<
        { user_id: string; family_id: string; expires_at: Date }[]
      >`
        SELECT t.user_id, t.family_id, t.expires_at
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
                    AND later.created_at > t.created_at
                    AND later.used_at IS NOT NULL)`;
      if (!presented) return null;

      // AU-040: `expires_at > now` above is what keeps an expired family out
      // of the grace; the re-issue inherits the same expiry.
      const issued = await this.issue(
        tx,
        presented.user_id,
        presented.family_id,
        presented.expires_at,
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
      // is either a very bad network or somebody racing its owner. The family
      // lets it be matched with a later REFRESH_TOKEN_REUSE.
      this.logger.warn(
        {
          user_id: presented.user_id,
          family_id: presented.family_id,
          action: 'REFRESH_TOKEN_REUSE_GRACE',
        },
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
    return (await this.familyState(familyId)) === 'open';
  }

  /**
   * AU-036, AU-040. `isFamilyOpen`, telling apart the two ways a family stops
   * being open: somebody revoked it, or it reached its lifetime. The same one
   * indexed lookup, aggregated: no live row is «revoked»; live rows whose
   * latest expiry has passed are «expired». The LATEST, not any: rows issued
   * before AU-040 each carried their own sliding expiry, and the newest one is
   * the one the family lives by.
   *
   * Without the expiry here, an access token issued in the family's last
   * minute would keep working a full `JWT_ACCESS_TTL` past the ceiling.
   */
  async familyState(familyId: string): Promise<FamilyState> {
    const { _max } = await this.prisma.refreshToken.aggregate({
      where: { familyId, revokedAt: null },
      _max: { expiresAt: true },
    });
    if (_max.expiresAt === null) return 'revoked';
    return _max.expiresAt > new Date() ? 'open' : 'expired';
  }

  /**
   * Closes one session. The other sessions of the user stay open. Locks before
   * writing: see `revokeLiveSessions` for why a single `UPDATE` let a
   * concurrent rotation keep the session open.
   */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.$transaction((tx) =>
      revokeLiveSessions(tx, { familyId }, reason),
    );
  }

  /**
   * Closes every session of the account. Used on deactivation (AU-023) and
   * when an inactive account tries to refresh. The password change, the
   * second-factor reset (AU-036) and credential redemption close sessions
   * inside their own transactions, through the same `revokeLiveSessions`.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.$transaction((tx) =>
      revokeLiveSessions(tx, { userId }, reason),
    );
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
   * `expiresAt` is the FAMILY's (AU-040): computed once, at sign-in.
   */
  private async issue(
    db: Db,
    userId: string,
    familyId: string,
    expiresAt: Date,
    ctx: ClientContext,
  ): Promise<IssuedRefreshToken> {
    const { token, hash } = this.tokens.generateRefreshToken();

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
