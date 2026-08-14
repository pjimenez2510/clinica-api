import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';

/** Who is asking, so the trail can say so (CF-066). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * What the mutation replaced and what it left (AG-097, CF-066, D-017).
 *
 * `before` is absent on a creation and `after` on a deletion; a rename carries
 * both.
 *
 * `Readonly<object>` and not the port's `Record<string, unknown>`: the callers
 * hold INTERFACES — `HolidayView`, `SiteParameterView` — and TypeScript
 * withholds the implicit index signature from an interface, so the stricter
 * type would force a spread at every call site and buy nothing. The rule that
 * matters cannot be typed anyway: what travels is the DOMAIN view, never the
 * ORM row. The repositories return domain views precisely so that there is
 * nothing else within reach to pass.
 */
export interface ConfigurationChange {
  before?: Readonly<object>;
  after?: Readonly<object>;
}

/**
 * Every mutation of a holiday or a parameter in the trail (CF-066).
 *
 * A collaborator and not a private method copied into two services: CF-066 is
 * one promise about two kinds of row, and the value of the trail is that a
 * single query answers «quién cambió la configuración de esta clínica, y
 * cuándo». Two private copies is two chances for one of them to write a
 * different discriminator, and nothing would fail until somebody audited.
 *
 * `resourceType` IS `'configuration'`, which is also what `specialties` writes
 * for rows that predate ADR-011. That is not an accident to be corrected here:
 * those rows ARE configuration in the sense the trail means, and this module
 * is the one that kept the name.
 *
 * A failure to record never blocks the mutation: that is the port's contract,
 * and the alternative is a clinic unable to register a holiday because the
 * audit table is full.
 */
@Injectable()
export class ConfigurationAuditTrail {
  constructor(
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  async record(
    action: AuditAction,
    resourceId: string,
    requester: Requester,
    change: ConfigurationChange = {},
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'configuration',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
      /**
       * AG-097, CF-066. Copied rather than passed along, so what reaches the
       * column is a plain JSON object: a class instance would serialise to
       * whatever its own fields happen to be, and a shared reference could be
       * mutated between here and the INSERT.
       *
       * `'configuration'` is on the whitelist of
       * `access_audit_payload_only_for_declared_resources` — it is a date, a
       * name, a scope, four numbers and two flags, with no PHI reachable from
       * any of them. That is why this trail may carry a payload and the one
       * recording chart accesses may not.
       */
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
    });
  }
}
