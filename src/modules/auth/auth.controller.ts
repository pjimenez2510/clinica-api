import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { RolePermissionRegistry } from './infrastructure/role-permission.registry';
import { TokenService } from './infrastructure/token.service';
import {
  ChangePasswordDto,
  ConfirmMfaDto,
  type MfaChallengeResponse,
  type SessionResponse,
  SignInDto,
  VerifyMfaDto,
} from './dto/auth.dto';
import { CurrentUserService } from './infrastructure/jwt-auth.guard';

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

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly isProduction: boolean;
  private readonly cookieName: string;

  constructor(
    private readonly auth: AuthService,
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
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const userId = this.currentUser.requireUserId();
    const session = await this.auth.verifyMfa(
      userId,
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
  async enrollMfa(): Promise<{ secret: string; uri: string }> {
    return this.auth.enrollMfa(this.currentUser.requireUserId());
  }

  /** Confirms enrolment by proving the authenticator was actually configured. */
  @Post('mfa/confirm')
  @MfaFlowOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm second factor enrolment' })
  async confirmMfa(@Body() dto: ConfirmMfaDto): Promise<void> {
    await this.auth.confirmMfaEnrollment(
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
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    const user = this.currentUser.get();
    if (user) await this.auth.signOut(user.fam);

    this.clearRefreshCookie(res);
  }

  @Post('password')
  @OwnAccount()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password and close every session' })
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
      expires: expiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/',
    });
  }

  private readRefreshCookie(req: Request): string {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      this.cookieName
    ];
    if (!token) throw new MissingRefreshCookieError();
    return token;
  }

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
  }): Promise<SessionResponse> {
    const assignments = await this.auth.grantsFor(session.user.id);

    return {
      accessToken: session.accessToken,
      expiresIn: this.tokens.accessTokenSeconds,
      user: session.user,
      grants: await this.roles.resolve(assignments),
    };
  }
}
