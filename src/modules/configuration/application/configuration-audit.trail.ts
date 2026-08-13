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
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'configuration',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
