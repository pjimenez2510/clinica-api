import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { Cedula } from '../../../shared/domain/value-objects/cedula.vo';
import {
  CACHE_LIFETIME_DAYS,
  IDENTITY_LOOKUPS,
  LOOKUP_TIMEOUT_MS,
  type IdentityFinding,
  type IdentityLookup,
  type IdentityProposal,
  type IdentitySource,
} from '../domain/identity-proposal';
import {
  CEDULA_DIGESTER,
  IDENTITY_LOOKUP_CLOCK,
  IDENTITY_LOOKUP_STORE,
  type CedulaDigester,
  type IdentityLookupClock,
  type IdentityLookupStore,
  type RegistryStatus,
} from '../domain/identity-lookup.store';

export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** IL-010. What the settings screen reads. */
export interface IdentityLookupSettings {
  externalSourcesEnabled: boolean;
  registry: RegistryStatus | null;
  providerConfigured: boolean;
  digestKeyConfigured: boolean;
}

/**
 * IL-006. The trail names the source in `resource_type`: `access_audit`
 * refuses a payload for non-administrative resources, and the source is the
 * kind of thing that was read.
 */
const TRAIL_RESOURCE: Record<IdentitySource, string> = {
  SRI_RUC_REGISTRY: 'identity_lookup:sri_ruc_registry',
  PROVIDER: 'identity_lookup:provider',
};

const DAY_MS = 86_400_000;

/**
 * D-206 §2. Proposing the names of a cedula from the external sources, and
 * the switch that allows it.
 *
 * NEVER BLOCKS (IL-003). Whatever a source does —throws, hangs, answers
 * garbage— the caller gets a proposal or `null`, and the desk types the name
 * as it always did. The only error that reaches the client is a malformed
 * request (IL-004), which the DTO answers before this runs.
 */
@Injectable()
export class IdentityLookupService {
  private readonly logger = new Logger(IdentityLookupService.name);

  constructor(
    @Inject(IDENTITY_LOOKUPS) private readonly lookups: IdentityLookup[],
    @Inject(IDENTITY_LOOKUP_STORE) private readonly store: IdentityLookupStore,
    @Inject(CEDULA_DIGESTER) private readonly digester: CedulaDigester | null,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(IDENTITY_LOOKUP_CLOCK) private readonly clock: IdentityLookupClock,
  ) {}

  /** IL-001 to IL-003, IL-006, IL-007. */
  async propose(
    cedulaText: string,
    requester: Requester,
  ): Promise<IdentityProposal | null> {
    // The DTO already refused an invalid one (IL-004); this is the type.
    const cedula = Cedula.create(cedulaText);
    if (this.digester === null) return null;
    if (!(await this.store.isEnabled())) return null;

    const digest = this.digester.digest(cedula.toString());
    const lookedUpAt = this.clock();
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), LOOKUP_TIMEOUT_MS);
    try {
      for (const lookup of this.lookups) {
        if (budget.signal.aborted) break;
        const finding = await this.ask(lookup, cedula, digest, lookedUpAt, budget.signal); // prettier-ignore
        await this.record(lookup.source, digest, requester);
        if (finding) return { ...finding, lookedUpAt };
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** IL-010. */
  async settings(): Promise<IdentityLookupSettings> {
    return {
      externalSourcesEnabled: await this.store.isEnabled(),
      registry: await this.store.registryStatus(),
      providerConfigured: this.lookups.some((l) => l.source === 'PROVIDER'),
      digestKeyConfigured: this.digester !== null,
    };
  }

  /** IL-010. The change goes to the `configuration` trail with both values. */
  async setEnabled(
    enabled: boolean,
    requester: Requester,
  ): Promise<IdentityLookupSettings> {
    const { before } = await this.store.setEnabled(enabled, this.clock());
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'configuration',
      resourceId: 'identity-lookup',
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
      before: { externalSourcesEnabled: before },
      after: { externalSourcesEnabled: enabled },
    });
    return this.settings();
  }

  /**
   * One source, within what is left of the budget. The provider's answer is
   * read from the cache first and written to it after (IL-007); a failure of
   * either is logged and never thrown.
   */
  private async ask(
    lookup: IdentityLookup,
    cedula: Cedula,
    digest: string,
    now: Date,
    signal: AbortSignal,
  ): Promise<IdentityFinding | null> {
    const cacheable = lookup.source === 'PROVIDER';
    try {
      if (cacheable) {
        const hit = await this.store.cached(digest, now);
        if (hit) return hit;
      }
      const finding = await withinBudget(lookup.findByCedula(cedula, signal), signal); // prettier-ignore
      if (finding && cacheable) {
        await this.store
          .cache(digest, finding, now, new Date(now.getTime() + CACHE_LIFETIME_DAYS * DAY_MS)) // prettier-ignore
          .catch((error: unknown) => this.warn('cache_write_failed', lookup.source, error)); // prettier-ignore
      }
      return finding;
    } catch (error) {
      this.warn(signal.aborted ? 'timed_out' : 'failed', lookup.source, error);
      return null;
    }
  }

  /** IL-006. Who, when (`occurred_at`), which source, and the digest. */
  private record(
    source: IdentitySource,
    digest: string,
    requester: Requester,
  ): Promise<void> {
    return this.audit.record({
      userId: requester.userId,
      resourceType: TRAIL_RESOURCE[source],
      resourceId: digest,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /** IL-003, SC-087. The source and the error's NAME: never its message. */
  private warn(outcome: string, source: IdentitySource, error: unknown): void {
    // Keys of the log allowlist (`log-privacy.ts`): anything else is dropped.
    this.logger.warn(
      {
        dependency: source,
        result: outcome,
        error_code: error instanceof Error ? error.name : 'unknown',
      },
      'identity lookup source gave no answer',
    );
  }
}

/** IL-003. The source's promise, or a rejection the moment the budget ends. */
function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LookupTimeoutError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LookupTimeoutError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('source failed'));
      },
    );
  });
}

class LookupTimeoutError extends Error {
  override readonly name = 'LookupTimeoutError';
}
