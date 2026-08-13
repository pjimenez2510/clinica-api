import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';

/** Who is asking, so the trail can say so (AU-025). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Every mutation of an account, a role or a grant in the trail (AU-025).
 *
 * A collaborator and not a private method copied into two services: AU-025 is
 * one promise about accounts, roles and grants alike, and the value of the
 * trail is that a single query answers «quién cambió quién puede hacer qué, y
 * cuándo» — which is the first question an SPDP audit asks. Two private copies
 * is two chances for one of them to write a different discriminator, and
 * nothing would fail until somebody audited.
 *
 * WHAT NEVER REACHES IT: the password, the hash, the TOTP secret and the
 * backup codes. AU-025 says so explicitly, and the shape of this method is
 * what makes it true — there is nowhere to put them. Only the id of the row
 * that changed travels.
 */
@Injectable()
export class AuthAdminAuditTrail {
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
      resourceType: 'auth',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
