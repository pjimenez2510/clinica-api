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

/**
 * AS-185, D-255 §1. Where the requester may take vital signs AND dictate
 * them. Not `assistant:use`: nursing dictates without the consultation's
 * assistant. AS-161 (D-255 §2): a site with the assistant switched off is
 * cut too; the authorization to record is not asked — nothing of the
 * conversation is kept or sent out.
 */
export function withDictation(
  principal: Principal,
  enabledSites: readonly string[],
): SiteScope {
  return intersect(
    intersect(
      scopeOf(principal, 'vitals:write'),
      scopeOf(principal, 'assistant:dictate-vitals'),
    ),
    enabledSites,
  );
}
