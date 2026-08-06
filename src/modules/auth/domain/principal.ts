import type { Permission } from './permissions';

/**
 * Evaluating what an authenticated caller may do.
 *
 * Separate from the catalogue because the catalogue is imported by the seed
 * script, which Node runs with type stripping — and stripping cannot handle a
 * class with parameter properties. Splitting them also makes the dependency
 * honest: seeding needs to know which permissions EXIST, not how access is
 * decided.
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
  permissions: readonly string[];
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
