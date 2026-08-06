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
