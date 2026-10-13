import type { Request } from 'express';

import type { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import type { AssistantSiteSwitch } from '../../shared/clinical/assistant-site-switch.port';

import type { ProposalRequester } from './application/diagnosis-proposal.service';
import { type SiteScope, withAssistant } from './assistant-sites';

/**
 * AS-026, AS-039, AS-076. Who asks, with the sites where they may use the
 * assistant AND read or write the history (`withAssistant`) — and, for a
 * function that writes toward a record of its own, its permission too. The
 * sites with the assistant off are read now, on each request (AS-161).
 */
export async function assistantRequester(
  currentUser: CurrentUserService,
  siteSwitch: AssistantSiteSwitch,
  req: Request,
  /**
   * AS-076. What writing also needs for this function: the receta asks
   * `prescription:write` too — whoever may not prescribe does not send the
   * note out to have a receta proposed (clinical review m7).
   */
  alsoToWrite: readonly Permission[] = [],
): Promise<ProposalRequester> {
  const principal = currentUser.requirePrincipal();
  const enabled = await siteSwitch.enabledSites();
  return {
    userId: currentUser.requireUserId(),
    readSites: withAssistant(principal, 'record:read', enabled),
    writeSites: alsoToWrite
      .map((permission) => withAssistant(principal, permission, enabled))
      .reduce(both, withAssistant(principal, 'record:write', enabled)),
    ip: req.ip,
    userAgent: req.get('user-agent'),
  };
}

/** Two site scopes, as one: what both admit. */
function both(a: SiteScope, b: SiteScope): SiteScope {
  if (a === 'all') return b;
  if (b === 'all') return a;
  return a.filter((site) => b.includes(site));
}
