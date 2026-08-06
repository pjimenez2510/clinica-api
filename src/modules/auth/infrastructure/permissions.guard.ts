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
  SITE_SCOPE_KEY,
  type SiteScopeDeclaration,
} from '../../../shared/http/auth.decorators';
import type { Permission } from '../../../shared/authorisation/permission.catalogue';
import { Principal } from '../../../shared/authorisation/principal';

import { RolePermissionRegistry } from './role-permission.registry';

import type { AccessTokenClaims } from './token.service';

/**
 * Key under which the resolved principal is published in the request context.
 *
 * Declared BEFORE the class that uses it. It worked at the bottom of the file
 * thanks to module initialisation order, and that the linter said nothing was
 * the actual finding: `no-use-before-define` was missing from the config.
 */
export const PRINCIPAL = 'principal';

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
  constructor(missing: string) {
    super(`Route declares no ${missing}`);
  }
}

export class SiteNotInScopeError extends ForbiddenError {
  readonly code = 'SITE_SCOPE_DENIED';
  constructor(permission: string) {
    super(`Site is not in scope for ${permission}`, { permission });
  }
}

/** Claims are missing when JwtAuthGuard did not run. That is a wiring bug. */
export class PrincipalUnavailableError extends ForbiddenError {
  readonly code = 'PRINCIPAL_UNAVAILABLE';
  constructor() {
    super('No authenticated principal in the request context');
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
    private readonly roles: RolePermissionRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PermissionsGuard.name);
  }

  private routeName(context: ExecutionContext): string {
    return `${context.getClass().name}.${context.getHandler().name}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
        { route: this.routeName(context) },
        'route declares no permission and was refused',
      );
      throw new RouteNotSecuredError('permission');
    }

    const claims = this.cls.get<AccessTokenClaims | undefined>(CURRENT_USER);
    if (!claims) {
      /**
       * An invariant violation, not a use case.
       *
       * Building an empty principal here turned a guard-ordering bug into an
       * ordinary denial — indistinguishable, in the logs and to the caller,
       * from a permission the user simply does not have. It has to be loud.
       */
      this.logger.error(
        { route: this.routeName(context) },
        'permissions guard ran without authenticated claims',
      );
      throw new PrincipalUnavailableError();
    }

    // Permissions are resolved HERE, not carried in the token: once a role's
    // permissions are editable, a token would keep granting a permission that
    // was revoked until it expired.
    const principal = new Principal(
      claims.sub,
      await this.roles.resolve(claims.grants),
    );

    if (!principal.can(required)) {
      this.logger.warn(
        { user_id: principal.userId, error_code: 'PERMISSION_DENIED' },
        'permission denied',
      );
      throw new PermissionDeniedError(required);
    }

    /**
     * The SITE dimension. Holding a permission is not holding it here.
     *
     * `param:` is the only form the guard can enforce by itself — guards run
     * before pipes, so the body is unvalidated and unusable for an
     * authorisation decision. `query` shifts the check to the handler through
     * `siteScope()`, and `global` states that the route has no site dimension.
     * The declaration being mandatory is what stops "no site check" from being
     * something nobody thought about.
     */
    const siteScope = this.reflector.getAllAndOverride<
      SiteScopeDeclaration | undefined
    >(SITE_SCOPE_KEY, targets);

    if (!siteScope) {
      this.logger.error(
        { route: this.routeName(context) },
        'route declares a permission but no site scope',
      );
      throw new RouteNotSecuredError('site scope');
    }

    if (siteScope.startsWith('param:')) {
      const parameter = siteScope.slice('param:'.length);
      const request = context.switchToHttp().getRequest<{
        params?: Record<string, string>;
      }>();
      const siteId = request.params?.[parameter];

      if (!siteId || !principal.canAtSite(required, siteId)) {
        this.logger.warn(
          { user_id: principal.userId, error_code: 'SITE_SCOPE_DENIED' },
          'site not in scope',
        );
        throw new SiteNotInScopeError(required);
      }
    }

    // Published for the handlers, so query code can narrow by site without
    // parsing claims again.
    this.cls.set(PRINCIPAL, principal);
    return true;
  }
}
