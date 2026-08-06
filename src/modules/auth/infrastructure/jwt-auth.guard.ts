import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { UnauthorizedError } from '../../../shared/domain/errors/domain-error';
// A missing Authorization header is the SHAPE of the transport, so
// `MissingTokenError` stays here. An unfinished second factor is a business
// rule, so it does not.
import { MfaRequiredError } from '../domain/auth.errors';
import {
  CURRENT_USER,
  IS_PUBLIC_KEY,
  MFA_FLOW_ONLY_KEY,
} from '../../../shared/http/auth.decorators';

import { type AccessTokenClaims, TokenService } from './token.service';

export class MissingTokenError extends UnauthorizedError {
  readonly code = 'MISSING_TOKEN';
  constructor() {
    super('Authorization header is missing or malformed');
  }
}

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
    private readonly cls: ClsService,
  ) {}

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

    this.cls.set(CURRENT_USER, claims);
    return true;
  }

  private extractBearer(header?: string): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}

/** Reads the authenticated identity from anywhere in the request. */
@Injectable()
export class CurrentUserService {
  constructor(private readonly cls: ClsService) {}

  get(): AccessTokenClaims | undefined {
    return this.cls.get<AccessTokenClaims | undefined>(CURRENT_USER);
  }

  requireUserId(): string {
    const user = this.get();
    if (!user) throw new MissingTokenError();
    return user.sub;
  }
}
