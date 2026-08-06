import { SetMetadata } from '@nestjs/common';

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
export const MFA_OPTIONAL_KEY = 'auth:mfa_optional';
export const REQUIRED_PERMISSION_KEY = 'auth:permission';
export const OWN_ACCOUNT_KEY = 'auth:own_account';

/** Marks a route as reachable without authentication. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Allows a route to be reached with a session that has not yet completed the
 * second factor. Only for the MFA flow itself: verifying the code, and
 * enrolling.
 */
export const MfaOptional = (): MethodDecorator =>
  SetMetadata(MFA_OPTIONAL_KEY, true);

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
 * typo does not compile.
 */
export const RequirePermission = (
  permission: string,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

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
