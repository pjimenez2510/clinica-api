import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { Cedula } from '../../../shared/domain/value-objects/cedula.vo';
import type {
  IdentityFinding,
  IdentityLookup,
  IdentitySource,
} from '../domain/identity-proposal';
import type {
  CedulaDigester,
  IdentityLookupStore,
} from '../domain/identity-lookup.store';

import { IdentityLookupService } from './identity-lookup.service';

/** Synthetic, with a computed check digit; never a real person's. */
const CEDULA = '1710034065';
const digestOf = (cedula: string) =>
  createHmac('sha256', 'test-key').update(cedula).digest('hex');
const DIGEST = digestOf(CEDULA);
const DAY_MS = 86_400_000;

function finding(source: IdentitySource): IdentityFinding {
  return {
    source,
    sourceName: 'MORA VERA ANA LUCIA',
    familyName: 'MORA',
    secondFamilyName: 'VERA',
    givenName: 'ANA',
    secondGivenName: 'LUCIA',
    birthDate: null,
    orderToReview: source === 'SRI_RUC_REGISTRY',
  };
}

function source(
  name: IdentitySource,
  answer: (signal: AbortSignal) => Promise<IdentityFinding | null>,
) {
  const findByCedula = vi.fn((_c: Cedula, signal: AbortSignal) =>
    answer(signal),
  );
  return { source: name, findByCedula } satisfies IdentityLookup;
}

class MemoryStore implements IdentityLookupStore {
  enabled = true;
  entries = new Map<string, { finding: IdentityFinding; expiresAt: Date }>();
  isEnabled = () => Promise.resolve(this.enabled);
  setEnabled(enabled: boolean) {
    const before = this.enabled;
    this.enabled = enabled;
    return Promise.resolve({ before });
  }
  registryStatus = () => Promise.resolve(null);
  cached(digest: string, now: Date) {
    const entry = this.entries.get(digest);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= now) {
      this.entries.delete(digest);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.finding);
  }
  cache(digest: string, f: IdentityFinding, _at: Date, expiresAt: Date) {
    this.entries.set(digest, { finding: f, expiresAt });
    return Promise.resolve();
  }
}

describe('proposing the names of a cedula', () => {
  let now: Date;
  let store: MemoryStore;
  let trail: AccessAuditEntry[];
  const audit: AccessAuditRecorder = {
    record: (entry) => {
      trail.push(entry);
      return Promise.resolve();
    },
  };
  const digester: CedulaDigester = { digest: digestOf };
  const requester = { userId: 'user-1', ip: '127.0.0.1' };

  beforeEach(() => {
    now = new Date();
    store = new MemoryStore();
    trail = [];
  });
  afterEach(() => vi.useRealTimers());

  const service = (
    lookups: IdentityLookup[],
    options: { digester?: CedulaDigester | null } = {},
  ) =>
    new IdentityLookupService(
      lookups,
      store,
      options.digester === undefined ? digester : options.digester,
      audit,
      () => now,
    );

  it('IL-001 answers from the first source that has the person, with the instant', async () => {
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(finding('SRI_RUC_REGISTRY'))); // prettier-ignore
    const provider = source('PROVIDER', () =>
      Promise.resolve(finding('PROVIDER')),
    );

    const proposal = await service([registry, provider]).propose(
      CEDULA,
      requester,
    );

    expect(proposal).toMatchObject({ source: 'SRI_RUC_REGISTRY', familyName: 'MORA', lookedUpAt: now }); // prettier-ignore
    expect(provider.findByCedula).not.toHaveBeenCalled();
  });

  it('IL-001 asks the provider when the registry does not have the person, and answers null when nobody does', async () => {
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(null));
    const provider = source('PROVIDER', () =>
      Promise.resolve(finding('PROVIDER')),
    );
    expect(await service([registry, provider]).propose(CEDULA, requester)).toMatchObject({ source: 'PROVIDER' }); // prettier-ignore

    const nobody = source('PROVIDER', () => Promise.resolve(null));
    expect(await service([registry, nobody]).propose('0926687856', requester)).toBeNull(); // prettier-ignore
  });

  it('IL-002 asks no source and writes no trail while the switch is off', async () => {
    store.enabled = false;
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(finding('SRI_RUC_REGISTRY'))); // prettier-ignore

    expect(await service([registry]).propose(CEDULA, requester)).toBeNull();
    expect(registry.findByCedula).not.toHaveBeenCalled();
    expect(trail).toEqual([]);
  });

  it('IL-002 asks no source without the digest key, even with the switch on', async () => {
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(finding('SRI_RUC_REGISTRY'))); // prettier-ignore

    expect(await service([registry], { digester: null }).propose(CEDULA, requester)).toBeNull(); // prettier-ignore
    expect(registry.findByCedula).not.toHaveBeenCalled();
  });

  it('IL-003 moves on from a source that throws, and answers null instead of an error', async () => {
    const broken = source('SRI_RUC_REGISTRY', () => Promise.reject(new Error('connection refused'))); // prettier-ignore
    const provider = source('PROVIDER', () =>
      Promise.resolve(finding('PROVIDER')),
    );
    expect(await service([broken, provider]).propose(CEDULA, requester)).toMatchObject({ source: 'PROVIDER' }); // prettier-ignore

    store.entries.clear();
    const alsoBroken = source('PROVIDER', () =>
      Promise.reject(new Error('500')),
    );
    expect(await service([broken, alsoBroken]).propose(CEDULA, requester)).toBeNull(); // prettier-ignore
  });

  it('IL-003 gives up at three seconds on a source that never answers, and aborts its signal', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const hanging = source('PROVIDER', (signal) => {
      seen = signal;
      return new Promise(() => {});
    });

    const pending = service([hanging]).propose(CEDULA, requester);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(seen?.aborted).toBe(true);
  });

  it('IL-006 leaves one trail entry per source asked, with the digest and never the cedula', async () => {
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(null));
    const provider = source('PROVIDER', () => Promise.resolve(null));

    await service([registry, provider]).propose(CEDULA, requester);

    expect(trail).toEqual([
      expect.objectContaining({ resourceType: 'identity_lookup:sri_ruc_registry', resourceId: DIGEST, action: 'READ', userId: 'user-1' }), // prettier-ignore
      expect.objectContaining({ resourceType: 'identity_lookup:provider', resourceId: DIGEST, action: 'READ' }), // prettier-ignore
    ]);
    expect(JSON.stringify(trail)).not.toContain(CEDULA);
  });

  it('IL-007 reuses the provider answer for thirty days, and asks again once it expired', async () => {
    const provider = source('PROVIDER', () =>
      Promise.resolve(finding('PROVIDER')),
    );
    const lookup = service([provider]);

    await lookup.propose(CEDULA, requester);
    expect(store.entries.get(DIGEST)?.expiresAt).toEqual(new Date(now.getTime() + 30 * DAY_MS)); // prettier-ignore

    now = new Date(now.getTime() + 30 * DAY_MS - 1);
    expect(await lookup.propose(CEDULA, requester)).toMatchObject({
      source: 'PROVIDER',
    });
    expect(provider.findByCedula).toHaveBeenCalledTimes(1);
    // A cache hit is a consultation of the provider's data too.
    expect(trail.filter((e) => e.resourceType === 'identity_lookup:provider')).toHaveLength(2); // prettier-ignore

    now = new Date(now.getTime() + 1);
    await lookup.propose(CEDULA, requester);
    expect(provider.findByCedula).toHaveBeenCalledTimes(2);
  });

  it('IL-007 does not cache what the registry answers: it is already local', async () => {
    const registry = source('SRI_RUC_REGISTRY', () => Promise.resolve(finding('SRI_RUC_REGISTRY'))); // prettier-ignore
    await service([registry]).propose(CEDULA, requester);
    expect(store.entries.size).toBe(0);
  });

  it('IL-010 records the switch change with the value it replaced', async () => {
    store.enabled = false;
    const settings = await service([]).setEnabled(true, requester);

    expect(settings).toMatchObject({ externalSourcesEnabled: true, providerConfigured: false, digestKeyConfigured: true }); // prettier-ignore
    expect(trail).toEqual([
      expect.objectContaining({ resourceType: 'configuration', resourceId: 'identity-lookup', action: 'UPDATE', before: { externalSourcesEnabled: false }, after: { externalSourcesEnabled: true } }), // prettier-ignore
    ]);
  });
});
