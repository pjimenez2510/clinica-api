import type { Request } from 'express';

import type { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { ALL_SITES } from '../../shared/authorisation/principal';

import type { ProposalRequester } from './application/diagnosis-proposal.service';

/**
 * AS-026, AS-039, AS-076. Where the requester may use the assistant AND read
 * or write the history: `'query'` only checks `assistant:use` at some site,
 * so a site where they write but have no assistant is cut here (A3's
 * per-site switch will narrow the same list). Every assistant controller
 * asks it this way.
 */
export function assistantRequester(
  currentUser: CurrentUserService,
  req: Request,
): ProposalRequester {
  const principal = currentUser.requirePrincipal();
  const sites = (permission: Permission) => {
    const scope = principal.sitesFor(permission);
    return scope === ALL_SITES ? ('all' as const) : scope;
  };
  const assistant = sites('assistant:use');
  const within = (permission: Permission) =>
    intersect(sites(permission), assistant);
  return {
    userId: currentUser.requireUserId(),
    readSites: within('record:read'),
    writeSites: within('record:write'),
    ip: req.ip,
    userAgent: req.get('user-agent'),
  };
}

/** Two site scopes, as one: what both admit. */
function intersect(
  a: 'all' | readonly string[],
  b: 'all' | readonly string[],
): 'all' | readonly string[] {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return a.filter((site) => b.includes(site));
}
