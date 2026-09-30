import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import type { Env } from '../../shared/config/env.schema';
import { UnauthorizedError } from '../../shared/domain/errors/domain-error';
import {
  MfaFlowOnly,
  OwnAccount,
  Public,
} from '../../shared/http/auth.decorators';

import { AuthService } from './application/auth.service';
import { REFRESH_COOKIE_MARGIN_MS } from './domain/session';
import { CredentialInvitationsService } from './application/credential-invitations.service';
import { MfaEnrolmentService } from './application/mfa-enrolment.service';
import { RolePermissionRegistry } from './infrastructure/role-permission.registry';
import { TokenService } from './infrastructure/token.service';
import {
  ChangeMfaDto,
  ChangePasswordDto,
  ConfirmMfaDto,
  CredentialTokenStatusDto,
  type CredentialTokenStatusResponse,
  MfaChallengeResponseDto,
  MfaConfirmationResponseDto,
  type MfaConfirmationResponse,
  MfaEnrolmentResponseDto,
  type MfaChallengeResponse,
  SetCredentialDto,
  type SessionResponse,
  SessionResponseDto,
  SignInDto,
  VerifyMfaDto,
} from './dto/auth.dto';
import { CurrentUserService } from '../../shared/authorisation/current-user.service';

/**
 * 401 `MISSING_REFRESH_TOKEN` when `POST /auth/refresh` arrives without the
 * refresh cookie.
 */
export class MissingRefreshCookieError extends UnauthorizedError {
  readonly code = 'MISSING_REFRESH_TOKEN';
  constructor() {
    super('Refresh cookie is not present');
  }
}

/**
 * Name of the cookie carrying the refresh token.
 *
 * The `__Host-` prefix is enforced by the client: it only accepts the cookie
 * when it is Secure, has no Domain and Path is `/`. That makes cookie
 * injection from a sibling subdomain impossible.
 *
 * The catch — and it silently breaks local development — is that the prefix
 * REQUIRES Secure. Over plain HTTP the client discards the cookie outright, so
 * refresh never works and nothing reports an error. The name therefore has to
 * track the flag rather than being a constant.
 */
const REFRESH_COOKIE_SECURE = '__Host-refresh';
const REFRESH_COOKIE_PLAIN = 'refresh';

/**
 * The SESSION half of the auth routes: sign-in, second factor, refresh,
 * sign-out, own password, and the public first-credential flow. Every route is
 * `@Public()`, `@MfaFlowOnly()` or `@OwnAccount()` — none of them needs a role;
 * administration lives in `AuthAdminController`.
 *
 * The refresh token travels only in an httpOnly, SameSite=strict cookie and
 * never in a body, so page script cannot read it.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly isProduction: boolean;
  private readonly cookieName: string;

  constructor(
    private readonly auth: AuthService,
    private readonly mfaEnrolment: MfaEnrolmentService,
    /**
     * The first-credential flow lives on THIS controller and not on the
     * administration one, even though an administrator is what starts it. Its
     * two routes are `@Public()`, and `auth-admin.controller.ts` exists
     * precisely so that a public marker can never end up in the same file as
     * «administra a toda la clínica».
     */
    private readonly credentials: CredentialInvitationsService,
    private readonly currentUser: CurrentUserService,
    private readonly tokens: TokenService,
    private readonly roles: RolePermissionRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.isProduction =
      config.get('NODE_ENV', { infer: true }) === 'production';
    // The __Host- prefix is only valid alongside Secure, so both move together.
    this.cookieName = this.isProduction
      ? REFRESH_COOKIE_SECURE
      : REFRESH_COOKIE_PLAIN;
  }

  /**
   * Sign in with email and password.
   *
   * Rate limited harder than the global default: this is the endpoint credential
   * stuffing targets, and the per-account lockout alone does not stop a
   * distributed attack spread across many accounts.
   */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Sign in with email and password' })
  /**
   * DECLARING THE RESPONSE IS NOT DOCUMENTATION, IT IS THE CONTRACT.
   *
   * Without this the OpenAPI document says the endpoint answers with no
   * content, and a client generated from it types the body as `never`. The
   * frontend then writes the shape by hand — which is exactly how `user`
   * vanished from the refresh response with nothing to catch it.
   */
  @ApiExtraModels(SessionResponseDto, MfaChallengeResponseDto)
  @ApiOkResponse({
    // `oneOf`, porque el endpoint responde una cosa o la otra. Un cliente que
    // solo conociera la sesión trataría el reto de MFA como respuesta rota.
    schema: {
      oneOf: [
        { $ref: getSchemaPath(SessionResponseDto) },
        { $ref: getSchemaPath(MfaChallengeResponseDto) },
      ],
    },
  })
  async login(
    @Body() dto: SignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaChallengeResponse> {
    const result = await this.auth.signIn(
      dto.email,
      dto.password,
      this.clientContext(req),
    );

    if ('mfaRequired' in result) return result;

    this.setRefreshCookie(res, result.refreshToken, result.expiresAt);
    return await this.toSessionResponse(result);
  }

  /** Completes sign-in with the TOTP code. Reachable with an MFA-pending token. */
  @Post('mfa/verify')
  @MfaFlowOnly()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Complete sign-in with the second factor' })
  @ApiOkResponse({ type: SessionResponseDto })
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const userId = this.currentUser.requireUserId();
    // AU-041: the session epoch the challenge was issued under.
    const challengeEpoch = this.currentUser.get()?.sep;
    const session = await this.auth.verifyMfa(
      userId,
      typeof challengeEpoch === 'number' ? challengeEpoch : undefined,
      dto.code,
      this.clientContext(req),
    );

    this.setRefreshCookie(res, session.refreshToken, session.expiresAt);
    return await this.toSessionResponse(session);
  }

  /** Starts TOTP enrolment. Returns the secret once, for the QR code. */
  @Post('mfa/enroll')
  @MfaFlowOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start second factor enrolment' })
  @ApiOkResponse({ type: MfaEnrolmentResponseDto })
  async enrollMfa(): Promise<{ secret: string; uri: string }> {
    return this.mfaEnrolment.enroll(this.currentUser.requireUserId());
  }

  /**
   * Confirms enrolment by proving the authenticator was actually configured,
   * and returns the backup codes (AU-005).
   *
   * ⚠️ 200 AND NOT 204, and the difference matters to the client. The codes
   * exist in this response and nowhere else — only their hashes are stored —
   * so a caller that ignores the body leaves the person one lost phone away
   * from being locked out of the medical records.
   *
   * THROTTLED LIKE `mfa/verify`, and for a reason of its own: this route hands
   * out ten Argon2 hashes' worth of work per call, and a confirmation that is
   * retried in a loop would spend it on every attempt. It is defence in depth
   * and NOT what stops a double submission — the database settles that, in the
   * same statement that writes; see `confirmMfaWithBackupCodes`.
   */
  @Post('mfa/confirm')
  @MfaFlowOnly()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Confirm second factor enrolment' })
  @ApiOkResponse({ type: MfaConfirmationResponseDto })
  async confirmMfa(
    @Body() dto: ConfirmMfaDto,
  ): Promise<MfaConfirmationResponse> {
    return this.mfaEnrolment.confirm(
      this.currentUser.requireUserId(),
      dto.code,
    );
  }

  /**
   * AU-037. Starts CHANGING the second factor, proving the current one.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * `@OwnAccount()` AND NOT `@MfaFlowOnly()`, AND THE DIFFERENCE IS THE POINT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `mfa/enroll` and `mfa/confirm` are reachable by a HALF-authenticated
   * session, because they have to be: somebody who has not finished the second
   * factor is exactly who is setting one up. This route is the opposite
   * situation. It demands a COMPLETE session — which is what `@OwnAccount()`
   * gets, since `JwtAuthGuard` refuses any token with `mfa: false` outside the
   * MFA flow — plus a live code from the factor being replaced.
   *
   * No permission, and none would fit: this has no role dimension at all.
   * Changing your own second factor is not something a role grants, any more
   * than changing your own password is, and modelling it as one would mean an
   * employee whose role forgot the permission cannot change phones.
   *
   * Nothing here reads an id from the request: the subject is the caller, from
   * the token, always.
   *
   * THROTTLED like `mfa/verify`, because it accepts the same codes and would
   * otherwise be a second, unlimited door to guessing them.
   */
  @Post('mfa/change')
  @OwnAccount()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Empezar el cambio del segundo factor' })
  @ApiOkResponse({ type: MfaEnrolmentResponseDto })
  async changeMfa(
    @Body() dto: ChangeMfaDto,
  ): Promise<{ secret: string; uri: string }> {
    return this.mfaEnrolment.startChange(
      this.currentUser.requireUserId(),
      dto.code,
    );
  }

  /**
   * AU-037. Confirms the new authenticator and returns the NEW backup codes.
   *
   * ⚠️ 200 AND NOT 204, for the same reason as `mfa/confirm`: this response is
   * the only place the new batch ever exists, and it invalidates the previous
   * one — so a client that ignores the body leaves the person holding ten
   * codes that no longer open anything and none that do.
   *
   * IT DOES NOT CLEAR THE REFRESH COOKIE, unlike `password`. AU-037 does not
   * close sessions: there is nobody to distrust, because the person has just
   * proved they hold the factor being replaced.
   */
  @Post('mfa/change/confirm')
  @OwnAccount()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Confirmar el segundo factor nuevo' })
  @ApiOkResponse({ type: MfaConfirmationResponseDto })
  async confirmMfaChange(
    @Body() dto: ConfirmMfaDto,
  ): Promise<MfaConfirmationResponse> {
    return this.mfaEnrolment.confirmChange(
      this.currentUser.requireUserId(),
      dto.code,
    );
  }

  /**
   * Rotates the session from the refresh cookie.
   *
   * Public because the access token is expected to be expired by now — that is
   * the whole point of refreshing. Authentication comes from the cookie.
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the session' })
  @ApiOkResponse({ type: SessionResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const presented = this.readRefreshCookie(req);
    const rotated = await this.auth.refresh(presented, this.clientContext(req));

    this.setRefreshCookie(res, rotated.refreshToken, rotated.expiresAt);
    // The SAME shape `login` answers with. A reload has to rebuild the whole
    // session, and two different shapes for "here is your session" is how the
    // client ends up handling one of them wrong.
    return await this.toSessionResponse(rotated);
  }

  /** Closes the current session. Other devices stay signed in. */
  @Post('logout')
  @OwnAccount()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Close the current session' })
  @ApiNoContentResponse()
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    const user = this.currentUser.get();
    if (user) await this.auth.signOut(user.fam);

    this.clearRefreshCookie(res);
  }

  /**
   * Changes the caller's own password after proving the current one; the new
   * one goes through the same policy as a first credential, and every session
   * is closed.
   */
  @Post('password')
  @OwnAccount()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password and close every session' })
  @ApiNoContentResponse()
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(
      this.currentUser.requireUserId(),
      dto.currentPassword,
      dto.newPassword,
    );

    // Every session was revoked, including this one.
    this.clearRefreshCookie(res);
  }

  /**
   * AU-028. Is this invitation link still worth showing a form for?
   *
   * ⚠️ PUBLIC, AND IT HAS TO BE. Whoever opens it CANNOT SIGN IN — that is the
   * entire situation the link exists for — so requiring a token here would
   * make the flow impossible. It is the smallest possible public surface: one
   * boolean, and a date only when the answer is yes.
   *
   * It exists so the page can say «este enlace ya no sirve» BEFORE asking
   * somebody to think of a password. Without it, the only way to find out is
   * to type one and have it refused, which reads as «my password was wrong» to
   * a person who does not have one yet.
   *
   * ONE ANSWER FOR UNKNOWN, SPENT AND EXPIRED. Telling them apart turns this
   * into an oracle over the secret itself: «ya se usó» confirms the token
   * existed, «caducó» confirms somebody was invited.
   *
   * RATE LIMITED like `login`, and for the same reason: this is the endpoint
   * that answers yes-or-no about a guessable-shaped secret, so it is what a
   * brute force would aim at. The 256 bits of entropy in the token are the
   * real defence; this bounds the attempt rate anyway, because a defence with
   * one layer is a defence with none the day the other one is weakened.
   */
  @Get('credential/:token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Comprobar si un enlace de acceso sigue sirviendo' })
  @ApiOkResponse({ type: CredentialTokenStatusDto })
  async checkCredential(
    @Param('token') token: string,
  ): Promise<CredentialTokenStatusResponse> {
    const status = await this.credentials.check(token);

    return {
      valid: status.valid,
      expiresAt: status.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * AU-021, AU-028. Sets the first password from an invitation link.
   *
   * ⚠️ PUBLIC, for the same unavoidable reason as the route above: this IS how
   * somebody who cannot sign in gets a password. The token is the credential,
   * and it is single use — redeeming it spends it, so a link read from a
   * forwarded message after the fact is worth nothing.
   *
   * The password policy is the SAME one `changePassword` applies. It is not
   * restated anywhere: this is the path reachable without authentication, and
   * a second, weaker copy of those rules would matter most exactly here.
   *
   * No session is issued. The person is sent to the sign-in screen and uses
   * the password they have just chosen, which is also the first proof that it
   * is the one they think it is — issuing a session here would let a typo they
   * cannot see through go unnoticed until the next day.
   */
  @Post('credential')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Fijar la contraseña desde un enlace de acceso' })
  @ApiNoContentResponse()
  async setCredential(
    @Body() dto: SetCredentialDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.credentials.redeem(
      dto.token,
      dto.password,
      this.clientContext(req),
    );
  }

  /**
   * The refresh token travels ONLY in an httpOnly cookie, never in the response
   * body. In a clinical system a session stolen through XSS is a reportable
   * health data breach, and `localStorage` is readable by any injected script.
   */
  private setRefreshCookie(
    res: Response,
    token: string,
    expiresAt: Date,
  ): void {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      // `__Host-` requires Secure. In development over plain HTTP the browser
      // would reject it, so the prefix and the flag move together.
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/',
      // AU-040: past the family's expiry, so its refusal can say why.
      expires: new Date(expiresAt.getTime() + REFRESH_COOKIE_MARGIN_MS),
    });
  }

  /**
   * Same attributes as `setRefreshCookie`: a browser only clears a cookie whose
   * name, path and flags match the one it holds.
   */
  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/',
    });
  }

  /**
   * The refresh token is read from the cookie only, never from the body, which
   * is what keeps it out of reach of page script.
   */
  private readRefreshCookie(req: Request): string {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      this.cookieName
    ];
    if (!token) throw new MissingRefreshCookieError();
    return token;
  }

  /**
   * IP and user agent for the session row and the trail. `req.ip` is only the
   * client's address when `TRUST_PROXY_HOPS` matches the proxies in front.
   */
  private clientContext(req: Request): { ip?: string; userAgent?: string } {
    return { ip: req.ip, userAgent: req.get('user-agent') };
  }

  /**
   * Includes the resolved grants so the interface knows what to OFFER.
   *
   * NOT the authorisation — the API decides on every request. This only stops
   * the client showing a receptionist a "Historia clínica" menu entry that
   * answers 403: an interface full of buttons that fail teaches people the
   * system is broken, and they stop reporting the errors that matter.
   */
  private async toSessionResponse(session: {
    accessToken: string;
    user: { id: string; email: string; firstName: string; lastName: string };
    mfaEnabled: boolean;
  }): Promise<SessionResponse> {
    const assignments = await this.auth.grantsFor(session.user.id);

    return {
      accessToken: session.accessToken,
      expiresIn: this.tokens.accessTokenSeconds,
      user: session.user,
      /**
       * Travels in ALL THREE session responses — login, refresh and
       * mfa/verify — because all three are «here is your session» and a client
       * that has to guess which of them describes the account fully ends up
       * guessing wrong on the one that matters: refresh, the only path a
       * reload has.
       */
      mfaEnabled: session.mfaEnabled,
      grants: await this.roles.resolve(assignments),
    };
  }
}
