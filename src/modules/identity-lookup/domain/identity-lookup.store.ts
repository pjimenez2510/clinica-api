import type { IdentityFinding } from './identity-proposal';

/**
 * IL-007, IL-009, IL-010. What this module keeps: the switch, the provider's
 * cache and the status of the imported registry. A port, so the service is
 * exercised with doubles and the guarantees are exercised against PostgreSQL.
 */
export interface RegistryStatus {
  /** The latest file imported, as it was named. */
  fileName: string;
  importedAt: Date;
  /** People the registry table holds now, across every file imported. */
  people: number;
}

export interface IdentityLookupStore {
  /** IL-002. No row is OFF. */
  isEnabled(): Promise<boolean>;
  /** IL-010. Writes the switch and answers the value it replaced. */
  setEnabled(enabled: boolean, at: Date): Promise<{ before: boolean }>;
  registryStatus(): Promise<RegistryStatus | null>;
  /**
   * IL-007. The live entry for this digest, or `null`. An expired one is
   * deleted, never returned.
   */
  cached(digest: string, now: Date): Promise<IdentityFinding | null>;
  /** IL-007. Stores an answer and deletes every entry already expired. */
  cache(
    digest: string,
    finding: IdentityFinding,
    fetchedAt: Date,
    expiresAt: Date,
  ): Promise<void>;
}

export const IDENTITY_LOOKUP_STORE = Symbol('IdentityLookupStore');

/**
 * IL-006. The HMAC of a cedula with `IDENTITY_LOOKUP_DIGEST_KEY`: names the
 * person in the trail and the cache without writing the number. `null` when
 * the key is not configured, and then no external source is asked (IL-002).
 */
export interface CedulaDigester {
  digest(cedula: string): string;
}

export const CEDULA_DIGESTER = Symbol('CedulaDigester');

/** The instant of a lookup and of the cache's expiry: a port, for the tests. */
export type IdentityLookupClock = () => Date;

export const IDENTITY_LOOKUP_CLOCK = Symbol('IdentityLookupClock');
