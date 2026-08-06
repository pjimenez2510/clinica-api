import { applyDecorators, SetMetadata } from '@nestjs/common';

import type { Permission } from '../authorisation/permission.catalogue';

/**
 * Route-level authentication markers.
 *
 * They live in `shared/http` and not inside the auth module on purpose: shared
 * infrastructure (the health probes, for instance) needs `@Public()`, and
 * having `shared` import from a business module would invert the dependency
 * direction.
 *
 * The guard that reads this metadata does live in the auth module.
 */

export const IS_PUBLIC_KEY = 'auth:public';
export const MFA_FLOW_ONLY_KEY = 'auth:mfa_flow_only';
export const REQUIRED_PERMISSION_KEY = 'auth:permission';
export const OWN_ACCOUNT_KEY = 'auth:own_account';
export const SITE_SCOPE_KEY = 'auth:site_scope';

/** Marks a route as reachable without authentication. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * The MFA flow itself, and nothing else.
 *
 * Reachable by a session that has not completed the second factor — verifying
 * the code, enrolling, confirming. It ALSO SKIPS THE PERMISSION CHECK
 * entirely, because such a session holds no grants yet and requiring one would
 * make the second factor impossible to complete.
 *
 * Renamed from `@MfaOptional()`, which said "MFA is optional here" and not
 * "this route checks no permissions". Somebody would eventually have put the
 * old name on a fourth route meaning the first thing. The exact list is
 * asserted in `route-authorisation.spec.ts`.
 */
export const MfaFlowOnly = (): MethodDecorator =>
  SetMetadata(MFA_FLOW_ONLY_KEY, true);

/** Key under which the authenticated identity is published in the request context. */
export const CURRENT_USER = 'currentUser';

/**
 * The permission a route demands. Every non-public route needs one.
 *
 * CLOSED BY DEFAULT: a route with neither this nor `@Public()` is REFUSED, it
 * is not allowed through. The alternative — treating an absent annotation as
 * "no restriction" — turns forgetting into a hole in the wall, and forgetting
 * is the failure mode application-level authorisation actually has. See
 * ADR-007 §3.
 *
 * The permission string is not free text: `Permission` is a closed union, so a
 * typo does not compile. That claim used to be false — the parameter was
 * `string` — and it was the comment itself that told the reader not to check.
 */
/**
 * How a route handles the SITE dimension of authorisation.
 *
 * Closed by default here too: a route must say which of these it is, and the
 * route-coverage test fails if it does not. Holding a permission is not the
 * same as holding it at the site being touched, and in a multi-site clinic the
 * site is the dimension that produces improper access.
 *
 *   - `param:<name>` — the site id is a route parameter and the GUARD checks
 *     it. The strongest option, and the only one the guard can enforce on its
 *     own. Use it whenever the site is in the URL.
 *   - `query` — the site is not in the URL, so the HANDLER must narrow with
 *     `siteScope()`. The guard cannot verify this; the declaration is what
 *     makes the omission visible in review.
 *   - `global` — the route is genuinely not site-scoped: managing users,
 *     reading catalogues. Stating it is the point, so that "no site check" is
 *     a decision somebody wrote down rather than something nobody thought
 *     about.
 *
 * NOTE ON `param:` — guards run BEFORE pipes, so the body is unvalidated at
 * that moment and cannot be trusted for an authorisation decision. Only route
 * parameters are readable this early. That is a constraint of the framework,
 * not a preference.
 */
export type SiteScopeDeclaration = `param:${string}` | 'query' | 'global';

export const RequirePermission = (
  permission: Permission,
  siteScope: SiteScopeDeclaration,
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSION_KEY, permission),
    SetMetadata(SITE_SCOPE_KEY, siteScope),
  );

/**
 * Any authenticated user, acting on their OWN account: signing out, changing
 * their own password.
 *
 * A separate marker rather than a permission every role happens to hold. A
 * permission can be left off a role by accident, and the result would be an
 * employee unable to sign out or change their password — a defect that looks
 * like a bug and is actually an authorisation gap. This category has no role
 * dimension at all, so modelling it as one would be a lie.
 *
 * It does NOT mean "no checks": the handler is still responsible for acting on
 * the caller's own identity and never on an id taken from the request.
 */
export const OwnAccount = (): MethodDecorator =>
  SetMetadata(OWN_ACCOUNT_KEY, true);
