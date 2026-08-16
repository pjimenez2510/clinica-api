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

/**
 * Asserts the caller may act on EVERY site of a set (ST-047).
 *
 * For the routes whose site dimension arrives as a LIST in the body — the
 * sites a practitioner attends at — where the guard has nothing to check
 * before the pipes run. One refusal for the whole set, never one per site:
 * naming which of them was out of scope would answer «esa sede existe» to
 * whoever guesses identifiers, which is what AG-105 refuses to do too.
 *
 * The refusal is thrown before any write, so a set containing one foreign
 * site leaves the practitioner exactly as it was.
 */
export function assertSitesInScope(
  principal: Principal,
  permission: Permission,
  siteIds: Iterable<string>,
): void {
  for (const siteId of new Set(siteIds)) {
    assertSiteInScope(principal, permission, siteId);
  }
}

/**
 * Asserts the caller holds the permission AT EVERY SITE, present and future
 * (D-023).
 *
 * WHY THIS IS NOT «holds it at all the sites that exist». A grant confined to
 * Norte and Sur is not clinic-wide even when Norte and Sur are the only two
 * sites open: the clinic opens a third one next month and whatever was written
 * under this authority — a national holiday, a global role grant — applies
 * there too, decided by somebody who never had that site. Only
 * `user_role_grant.site_id IS NULL` means «todas, incluidas las que no
 * existen todavía», and `Principal.sitesFor` reports exactly that as
 * `ALL_SITES`.
 */
export function assertClinicWideScope(
  principal: Principal,
  permission: Permission,
): void {
  if (principal.sitesFor(permission) !== ALL_SITES) {
    throw new SiteScopeDeniedError(permission);
  }
}

/**
 * Asserts the caller may act on every scope of a set, where `null` is EVERY
 * SITE (D-023).
 *
 * FOR THE ROWS WHOSE SITE IS NULLABLE, and where the null is not «sin sede»
 * but «todas»: a holiday with `site_id IS NULL` shuts every site's agenda
 * (AG-015, CF-067), and a `user_role_grant` with `site_id IS NULL` carries its
 * role everywhere (AU-038). Writing either one is an act of clinic-wide reach,
 * so it demands clinic-wide authority — otherwise the site scope is undone by
 * a field of the body, which is precisely what D-023 found.
 *
 * ONE REFUSAL FOR THE WHOLE SET, and the same one either way: `SITE_SCOPE_DENIED`
 * names the permission and never a site, so it does not answer «esa sede
 * existe» to whoever guesses identifiers, nor distinguish «otra sede» from
 * «todas».
 */
export function assertScopesInScope(
  principal: Principal,
  permission: Permission,
  scopes: Iterable<string | null>,
): void {
  for (const scope of new Set(scopes)) {
    if (scope === null) assertClinicWideScope(principal, permission);
    else assertSiteInScope(principal, permission, scope);
  }
}
