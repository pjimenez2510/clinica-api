import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

// `MissingTokenError` lives in `shared/authorisation` because two places
// raise it: this guard, when the Authorization header is missing, and
// `CurrentUserService`, when nothing set an identity for the request. An
// unfinished second factor is a business rule, so `MfaRequiredError` does not
// move.
import { MissingTokenError } from '../../../shared/authorisation/current-user.service';
import {
  MfaRequiredError,
  SessionExpiredError,
  SessionRevokedError,
} from '../domain/auth.errors';
import { MFA_CHALLENGE_FAMILY } from '../domain/session';
import {
  CURRENT_USER,
  IS_PUBLIC_KEY,
  MFA_FLOW_ONLY_KEY,
} from '../../../shared/http/auth.decorators';

import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

/**
 * Validates the access token and publishes the identity into the request
 * context.
 *
 * No Passport. For a resource server that verifies a JWT it issued itself,
 * Passport adds two dependencies that have not shipped a release since 2023 in
 * exchange for indirection. This is the whole thing.
 *
 * IMPORTANT: guards run BEFORE pipes, so `request.body` here is UNVALIDATED.
 * Never take an authorization decision from the body — only from the token and
 * the route parameters.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    /**
     * AU-036. The session registry, consulted on every authenticated request.
     * See `assertSessionStillOpen` for why the signature alone is not enough.
     */
    private readonly sessions: RefreshTokenService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Order matters: `@Public()` short-circuits, a missing bearer is 401, a token
   * that has not passed the second factor only reaches `@MfaFlowOnly()` routes,
   * and a revoked family is refused even with a valid signature (AU-036). Only
   * then are the claims published for `PermissionsGuard`.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearer(request.headers.authorization);
    if (!token) throw new MissingTokenError();

    const claims = await this.tokens.verifyAccessToken(token);

    // A session that has not passed the second factor can only reach the MFA
    // flow itself. Without this check, the first token issued after the
    // password would already grant full access and MFA would be decorative.
    const mfaOptional = this.reflector.getAllAndOverride<boolean>(
      MFA_FLOW_ONLY_KEY,
      targets,
    );
    if (!claims.mfa && !mfaOptional) throw new MfaRequiredError();

    await this.assertSessionStillOpen(claims.fam, claims.sub, claims.sep);

    this.cls.set(CURRENT_USER, claims);
    return true;
  }

  /**
   * AU-036 — A VALID SIGNATURE IS NOT A LIVE SESSION.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THIS COSTS A QUERY PER REQUEST, AND WHY IT IS WORTH IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Until this check existed, every revocation in the system closed exactly
   * half a session. `resetMfa`, `rotateCredentials` and deactivating an account
   * all revoke the refresh chain — and the ACCESS token, already signed, kept
   * granting everything for up to `JWT_ACCESS_TTL` (15 minutes by default).
   *
   * The adversarial review of A4 turned that into a race for ownership of
   * somebody else's second factor, and it is worth stating in full because it
   * is the reason this is not a nice-to-have: `mfa/enroll` and `mfa/confirm`
   * carry `@MfaFlowOnly()`, which BY DESIGN skips the permission check — they
   * have to be reachable by a session that has not finished authenticating.
   * A reset leaves the account deliberately unenrolled. So whoever held the
   * previous session could, with a token issued BEFORE the reset, enrol THEIR
   * authenticator on the account support had just given back to its owner, and
   * walk away with the ten backup codes as well.
   *
   * TWO WAYS TO CLOSE IT, AND WHY THIS ONE. The alternative is an instant on
   * `app_user` — «credentials changed at» — compared against the token's `iat`.
   * It costs a column instead of a table, but the same one lookup per request,
   * and it has a failure mode this one does not: every future code path that
   * closes sessions must remember to bump the column, and forgetting is silent.
   * Deriving the answer from the revocation those paths ALREADY write means a
   * new one cannot forget. It also avoids reasoning about `iat`, which is
   * second-resolution and would need a tie-break rule at the boundary.
   *
   * WHAT IS DELIBERATELY NOT CACHED: nothing. A cache here is a window, and the
   * window is the entire defect.
   *
   * THE MFA CHALLENGE TOKEN IS CHECKED DIFFERENTLY, NOT EXEMPTED. It carries
   * the magic family `MFA_CHALLENGE_FAMILY` and has no `refresh_token` row by
   * construction — the row is created when the second factor completes — so
   * the family check cannot apply. It was once exempted on the grounds that
   * whoever holds the password can get a fresh one anyway; that stops being
   * true the moment the password changes or the factor is reset, and an
   * exempted challenge then still reached `mfa/enroll` (clean-context review,
   * 30-09-2026). It is checked against the session epoch it carries (AU-041).
   */
  private async assertSessionStillOpen(
    familyId: string,
    userId: string,
    challengeEpoch: number | undefined,
  ): Promise<void> {
    /**
     * AU-041. The challenge has no family, but it is not exempt: it carries
     * the session epoch read with the password. Closing every session of the
     * account (a reset, a password change, a deactivation) voids it, and so
     * does the account being inactive. Without this, a challenge obtained
     * before a second-factor reset still reached `mfa/enroll` — its holder,
     * with the password and without the phone, could enrol THEIR authenticator
     * on the account support had just given back.
     */
    if (familyId === MFA_CHALLENGE_FAMILY) {
      if (await this.sessions.isChallengeCurrent(userId, challengeEpoch)) {
        return;
      }
      throw new SessionRevokedError();
    }

    // AU-040: a family that reached its lifetime is closed too, and says so.
    const state = await this.sessions.familyState(familyId);
    if (state === 'open') return;
    throw state === 'expired'
      ? new SessionExpiredError()
      : new SessionRevokedError();
  }

  /**
   * Only the `Bearer <token>` scheme, case-insensitive; anything else counts as
   * no token at all.
   */
  private extractBearer(header?: string): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
