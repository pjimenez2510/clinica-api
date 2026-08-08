import type { Permission } from './permission.catalogue';

/**
 * Evaluating what an authenticated caller may do.
 *
 * IN `shared/`, NOT IN `modules/auth/`. Every business module needs to know who
 * the caller is and what they may do, and `dependency-cruiser` forbids one
 * module importing another. Leaving this inside the auth module meant the first
 * clinical module would collide with our own architecture rule — and the fix
 * under deadline is an exception in `.dependency-cruiser.cjs`. Architecture
 * rules die by accumulated exceptions, not all at once.
 *
 * `modules/auth` PRODUCES the principal; `shared/authorisation` is the
 * vocabulary everyone CONSUMES. Startup policy — the default roles, the risky
 * combinations — stays in the module: that is auth's business, not shared
 * vocabulary.
 *
 * Separate from the catalogue because the catalogue is imported by the seed
 * script, which Node runs with type stripping, and stripping cannot handle a
 * class with parameter properties.
 */

/**
 * A role the caller holds, with its permissions already resolved, at one site
 * or everywhere (`siteId: null`).
 *
 * Resolved rather than looked up here on purpose: this file must stay free of
 * I/O so the rules can be tested without a database. Reading the role's
 * permissions is the infrastructure's job.
 */
export interface ResolvedGrant {
  roleCode: string;
  siteId: string | null;
  /**
   * `Permission`, not `string`.
   *
   * These codes come from the catalogue, and typing them loosely defeated the
   * point of having one: `can('paceint:read')` compiled happily and simply
   * never matched. It also let the response DTO — which declares the catalogue
   * as an enum so the contract carries it — go out of sync with what actually
   * travels in it.
   */
  permissions: readonly Permission[];
}

/**
 * A role held, by id, at one site or everywhere.
 *
 * This is what the token carries and what the repository returns — the ID
 * only. Which permissions it implies is resolved per request, so revoking one
 * does not have to wait for every live token to expire.
 */
export interface RoleAssignment {
  roleId: string;
  siteId: string | null;
}

/** Every site is in scope, without enumerating them. */
export const ALL_SITES = Symbol('ALL_SITES');

/**
 * The authenticated caller, and what they are allowed to do.
 *
 * `sitesFor` exists because "can they?" is not enough in a multi-site clinic:
 * a receptionist hired at one site may list appointments, but only that site's.
 * Query code asks which sites are in scope and filters. Without it every route
 * would reimplement the same filter, and one of them would get it wrong.
 */
export class Principal {
  constructor(
    readonly userId: string,
    readonly grants: readonly ResolvedGrant[],
  ) {}

  can(permission: Permission): boolean {
    return this.grants.some((grant) => grant.permissions.includes(permission));
  }

  /**
   * Sites where the caller holds this permission.
   *
   * An EMPTY array means the permission is held nowhere. Callers must treat
   * that as a denial and never as "no filter to apply" — the difference
   * between showing nothing and showing everything.
   */
  sitesFor(permission: Permission): typeof ALL_SITES | string[] {
    const holding = this.grants.filter((grant) =>
      grant.permissions.includes(permission),
    );

    if (holding.some((grant) => grant.siteId === null)) return ALL_SITES;
    return [
      ...new Set(
        holding
          .map((grant) => grant.siteId)
          .filter((siteId): siteId is string => siteId !== null),
      ),
    ];
  }

  canAtSite(permission: Permission, siteId: string): boolean {
    const scope = this.sitesFor(permission);
    return scope === ALL_SITES || scope.includes(siteId);
  }
}
