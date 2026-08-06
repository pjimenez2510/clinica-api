import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'; // prettier-ignore
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { ForbiddenError } from '../../../shared/domain/errors/domain-error';
import {
  CURRENT_USER,
  IS_PUBLIC_KEY,
  MFA_OPTIONAL_KEY,
  OWN_ACCOUNT_KEY,
  REQUIRED_PERMISSION_KEY,
} from '../../../shared/http/auth.decorators';
import { type Permission, Principal } from '../domain/permissions';

import type { AccessTokenClaims } from './token.service';

export class PermissionDeniedError extends ForbiddenError {
  readonly code = 'PERMISSION_DENIED';
  constructor(permission: string) {
    // The permission IS named. It is not a secret — the caller knows which
    // endpoint they called — and hiding it only makes the failure harder to
    // report. What is never named is who else holds it.
    super(`Missing permission ${permission}`, { permission });
  }
}

export class RouteNotSecuredError extends ForbiddenError {
  readonly code = 'ROUTE_NOT_SECURED';
  constructor() {
    super('Route declares no permission');
  }
}

/**
 * Enforces the permission a route demands. See ADR-007 §3.
 *
 * CLOSED BY DEFAULT, and that is the entire design. A route with neither
 * `@RequirePermission()` nor `@Public()` is REFUSED. The obvious alternative —
 * letting an unannotated route through — turns a moment of forgetfulness into
 * an open door, and forgetting is precisely the failure mode that
 * application-level authorisation has. Row-level security in PostgreSQL would
 * not have that weakness, and the reasons it was still rejected are in
 * ADR-007.
 *
 * A refusal here is logged at `error`, not `warn`: an unsecured route is a
 * defect in our code, not a client mistake, and it must be noisy enough that
 * somebody notices before it reaches production. There is also a test that
 * walks every registered route and fails if any lacks a declaration.
 *
 * Runs AFTER JwtAuthGuard, which is what puts the claims in the context.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PermissionsGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    // The MFA endpoints are reached by a session that has not finished
    // authenticating, so it holds no grants yet. Requiring a permission there
    // would make the second factor impossible to complete.
    if (this.reflector.getAllAndOverride<boolean>(MFA_OPTIONAL_KEY, targets)) {
      return true;
    }

    // Acting on one's own account carries no role dimension: signing out and
    // changing your own password are not things a role grants.
    if (this.reflector.getAllAndOverride<boolean>(OWN_ACCOUNT_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );

    if (!required) {
      this.logger.error(
        { route: context.getClass().name + '.' + context.getHandler().name },
        'route declares no permission and was refused',
      );
      throw new RouteNotSecuredError();
    }

    const claims = this.cls.get<AccessTokenClaims | undefined>(CURRENT_USER);
    const principal = new Principal(claims?.sub ?? '', claims?.grants ?? []);

    if (!principal.can(required)) {
      this.logger.warn(
        { user_id: principal.userId, error_code: 'PERMISSION_DENIED' },
        'permission denied',
      );
      throw new PermissionDeniedError(required);
    }

    // Published for the handlers, so query code can narrow by site without
    // parsing claims again.
    this.cls.set(PRINCIPAL, principal);
    return true;
  }
}

/** Key under which the resolved principal is published in the request context. */
export const PRINCIPAL = 'principal';
