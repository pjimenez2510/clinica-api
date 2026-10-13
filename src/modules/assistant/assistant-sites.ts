import type { Permission } from '../../shared/authorisation/permission.catalogue';
import {
  ALL_SITES,
  type Principal,
} from '../../shared/authorisation/principal';

export type SiteScope = 'all' | readonly string[];

/**
 * AS-026, AS-161. Where the requester may do `permission` AND use the
 * assistant: `@RequirePermission('assistant:use', 'query')` only checks the
 * assistant at SOME site, so a site where they write without the assistant is
 * cut here — and so is a site with the assistant switched off (A3), which
 * then answers like a site out of reach.
 */
export function withAssistant(
  principal: Principal,
  permission: Permission,
  enabledSites: readonly string[],
): SiteScope {
  return intersect(
    intersect(
      scopeOf(principal, permission),
      scopeOf(principal, 'assistant:use'),
    ),
    enabledSites,
  );
}

function scopeOf(principal: Principal, permission: Permission): SiteScope {
  const scope = principal.sitesFor(permission);
  return scope === ALL_SITES ? 'all' : scope;
}

/** Two site scopes, as one: what both admit. */
function intersect(a: SiteScope, b: SiteScope): SiteScope {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return a.filter((site) => b.includes(site));
}
