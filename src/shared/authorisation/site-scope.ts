import { ForbiddenError } from '../domain/errors/domain-error';

import type { Permission } from './permission.catalogue';
import { ALL_SITES, type Principal } from './principal';

export class SiteScopeDeniedError extends ForbiddenError {
  readonly code = 'SITE_SCOPE_DENIED';
  constructor(permission: string) {
    super(`No site in scope for ${permission}`, { permission });
  }
}

/**
 * The `where` clause that confines a query to the caller's sites.
 *
 * WHY THIS EXISTS AS A FUNCTION: the guard can only validate a site id it can
 * see, and it runs before the pipes — so for anything whose site arrives in the
 * body or is implied by a related record, the filter has to happen in the
 * query. Leaving that to each handler is the same "somebody forgets" failure
 * the closed-by-default guard was built to remove, except in the dimension
 * that actually produces improper access in a multi-site clinic.
 *
 * THE PART THAT MATTERS: an empty scope THROWS. `Principal.sitesFor` returns an
 * empty array when the permission is held nowhere, and the tempting reading of
 * that is "no filter to apply" — which turns a denial into a query that returns
 * every site's data. Making it impossible to spell that mistake is the whole
 * reason this is not written inline.
 *
 * @example
 *   const where = siteScope(principal, 'agenda:read');
 *   return prisma.agendaEntry.findMany({ where: { ...where, date } });
 */
export function siteScope(
  principal: Principal,
  permission: Permission,
): Record<string, never> | { siteId: { in: string[] } } {
  const scope = principal.sitesFor(permission);

  if (scope === ALL_SITES) return {};

  // NOT an empty filter. The caller holds this permission at no site at all,
  // and returning `{}` here would widen that to every site.
  if (scope.length === 0) throw new SiteScopeDeniedError(permission);

  return { siteId: { in: scope } };
}

/**
 * Asserts the caller may act on ONE named site.
 *
 * For writes, where the site is a single known value rather than a filter.
 */
export function assertSiteInScope(
  principal: Principal,
  permission: Permission,
  siteId: string,
): void {
  if (!principal.canAtSite(permission, siteId)) {
    throw new SiteScopeDeniedError(permission);
  }
}
