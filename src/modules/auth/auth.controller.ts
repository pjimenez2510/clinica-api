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
  MfaOptional,
  OwnAccount,
  Public,
} from '../../shared/http/auth.decorators';

import { AuthService } from './application/auth.service';
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
    return this.toSessionResponse(result);
  }

  /** Completes sign-in with the TOTP code. Reachable with an MFA-pending token. */
  @Post('mfa/verify')
  @MfaOptional()
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
    return this.toSessionResponse(session);
  }

  /** Starts TOTP enrolment. Returns the secret once, for the QR code. */
  @Post('mfa/enroll')
  @MfaOptional()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start second factor enrolment' })
  async enrollMfa(): Promise<{ secret: string; uri: string }> {
    return this.auth.enrollMfa(this.currentUser.requireUserId());
  }

  /** Confirms enrolment by proving the authenticator was actually configured. */
  @Post('mfa/confirm')
  @MfaOptional()
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
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const presented = this.readRefreshCookie(req);
    const rotated = await this.auth.refresh(presented, this.clientContext(req));

    this.setRefreshCookie(res, rotated.refreshToken, rotated.expiresAt);
    return { accessToken: rotated.accessToken, expiresIn: 900 };
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

  private toSessionResponse(session: {
    accessToken: string;
    user: { id: string; email: string; firstName: string; lastName: string };
  }): SessionResponse {
    return {
      accessToken: session.accessToken,
      expiresIn: 900,
      user: session.user,
    };
  }
}
