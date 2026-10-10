import type { Cedula } from '../../../shared/domain/value-objects/cedula.vo';

/**
 * IL-001, IL-005. What an external source answers for a cedula.
 *
 * PURE DOMAIN: no I/O, no clock, no framework.
 */

/**
 * The external sources, in the order they are asked (D-206 §1). The patient
 * register itself comes first and is not here: PA-072 asks it from the screen.
 */
export const IDENTITY_SOURCES = ['SRI_RUC_REGISTRY', 'PROVIDER'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

/** The names a source found, split into the four fields of the chart. */
export interface IdentityNames {
  familyName: string | null;
  secondFamilyName: string | null;
  givenName: string | null;
  secondGivenName: string | null;
}

/** What one source found, before the service stamps the instant on it. */
export interface IdentityFinding extends IdentityNames {
  source: IdentitySource;
  /** The name exactly as the source wrote it (IL-005). */
  sourceName: string;
  /** `YYYY-MM-DD`, only when the source carries it. */
  birthDate: string | null;
  /**
   * IL-005, D-209. The split between surnames and names is a CONVENTION the
   * system applied, not data the source gave: the screen must say so.
   */
  orderToReview: boolean;
}

/** IL-001. The answer to the screen: a finding and when it was obtained. */
export interface IdentityProposal extends IdentityFinding {
  lookedUpAt: Date;
}

/**
 * The port of D-206 §2: one adapter per source, chosen by configuration (an
 * anti-corruption layer — the provider's shape never leaves its adapter).
 *
 * `signal` is the 3-second budget (IL-003): an adapter that honours it stops
 * waiting; one that does not is abandoned by the service anyway.
 */
export interface IdentityLookup {
  readonly source: IdentitySource;
  findByCedula(
    cedula: Cedula,
    signal: AbortSignal,
  ): Promise<IdentityFinding | null>;
}

/** Injection token for the ordered list of configured external sources. */
export const IDENTITY_LOOKUPS = Symbol('IdentityLookups');

/** IL-003. Every source together answers within this, or not at all. */
export const LOOKUP_TIMEOUT_MS = 3_000;

/** IL-007. How long a provider answer is reused. The base caps it at 90. */
export const CACHE_LIFETIME_DAYS = 30;
