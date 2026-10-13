import { describe, expect, it } from 'vitest';

import type { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';

import type { HolidaysService } from './application/holidays.service';
import type { SiteParametersService } from './application/site-parameters.service';
import { ConfigurationController } from './configuration.controller';

function controller(installed: boolean, scope: typeof ALL_SITES | string[]) {
  const currentUser = {
    requirePrincipal: () => ({ sitesFor: () => scope }),
  } as unknown as CurrentUserService;
  return new ConfigurationController(
    {} as HolidaysService,
    {} as SiteParametersService,
    currentUser,
    installed,
    { enabledSites: () => Promise.resolve(['site-1', 'site-2']) },
  );
}

describe('ConfigurationController — the sites with the assistant (AS-162)', () => {
  it('AS-162 none while the installation has the assistant off', async () => {
    await expect(controller(false, ALL_SITES).assistantSites()).resolves.toEqual({ siteIds: [] }); // prettier-ignore
  });

  it('AS-162 every site on for a caller of every site, and only those of their reach otherwise', async () => {
    await expect(controller(true, ALL_SITES).assistantSites()).resolves.toEqual({ siteIds: ['site-1', 'site-2'] }); // prettier-ignore
    await expect(controller(true, ['site-2', 'site-9']).assistantSites()).resolves.toEqual({ siteIds: ['site-2'] }); // prettier-ignore
  });
});
