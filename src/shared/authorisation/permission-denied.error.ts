import { ForbiddenError } from '../domain/errors/domain-error';

/**
 * 403 for a permission the caller does not hold. See the constructor for why
 * the permission is named in the response.
 */
export class PermissionDeniedError extends ForbiddenError {
  readonly code = 'PERMISSION_DENIED';
  constructor(permission: string) {
    // The permission IS named. It is not a secret — the caller knows which
    // endpoint they called — and hiding it only makes the failure harder to
    // report. What is never named is who else holds it.
    super(`Missing permission ${permission}`, { permission });
  }
}
