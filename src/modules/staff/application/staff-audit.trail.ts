import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';

/** Who is asking, so the trail can say so (ST-010, ST-044). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Every mutation of the staff file in the trail, under ONE `resourceType`.
 *
 * A collaborator and not a private method copied into three services: ST-010
 * and ST-044 are the same promise about different rows, and the value of the
 * trail is that a single query answers "who changed this practitioner's file,
 * and when" — profile, sites, specialties, durations and schedule alike. Three
 * private copies is three chances for one of them to write a different
 * discriminator, and nothing would fail until somebody audited.
 *
 * `resourceType` IS `'staff'` AND NOT `'configuration'`. The rows `specialties`
 * writes still say `configuration`, deliberately — a discriminator is a
 * WRITTEN VALUE, and rewriting the code without migrating the rows would split
 * one trail in two that no query joins. This module is new, so it has no
 * history to split and starts with the name ADR-011 gave it.
 *
 * A failure to record never blocks the mutation: that is the port's contract,
 * and the alternative is a clinic unable to correct a schedule because the
 * audit table is full.
 */
@Injectable()
export class StaffAuditTrail {
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
      resourceType: 'staff',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
