import { describe, expect, it } from 'vitest';

import type {
  IdentityFinding,
  IdentityLookup,
} from './domain/identity-proposal';
import { DiditIdentityLookup } from './infrastructure/didit-identity.lookup';
import { configuredLookups } from './identity-lookup.module';

const registry: IdentityLookup = {
  source: 'SRI_RUC_REGISTRY',
  findByCedula: (): Promise<IdentityFinding | null> => Promise.resolve(null), // prettier-ignore
};

describe('configuredLookups (IL-008)', () => {
  it('adds the provider second only when both URL and key are set', () => {
    const withProvider = configuredLookups(
      { providerUrl: 'https://verification.didit.me/v3/', providerApiKey: 'k' },
      registry,
    );
    expect(withProvider).toHaveLength(2);
    expect(withProvider[0]).toBe(registry);
    expect(withProvider[1]).toBeInstanceOf(DiditIdentityLookup);
  });

  it('leaves the provider out without credentials', () => {
    expect(configuredLookups({ providerUrl: 'https://x/', providerApiKey: '' }, registry)).toEqual([registry]); // prettier-ignore
    expect(configuredLookups({ providerApiKey: 'k' }, registry)).toEqual([registry]); // prettier-ignore
    expect(configuredLookups({}, registry)).toEqual([registry]);
  });
});
