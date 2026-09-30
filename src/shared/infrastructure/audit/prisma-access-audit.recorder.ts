import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../audit/access-audit.port';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Writes the access trail to PostgreSQL.
 *
 * The table refuses UPDATE and DELETE through triggers, and refuses TRUNCATE
 * too. That is the point of it: a trail somebody can quietly edit is not a
 * trail. This adapter therefore only ever inserts.
 */
@Injectable()
export class PrismaAccessAuditRecorder implements AccessAuditRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrismaAccessAuditRecorder.name);
  }

  /**
   * Insert only. A failure is logged at error level and swallowed, as the port
   * demands.
   */
  async record(entry: AccessAuditEntry): Promise<void> {
    try {
      await this.prisma.accessAudit.create({
        data: {
          userId: entry.userId,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          action: entry.action,
          ip: entry.ip,
          userAgent: entry.userAgent,
          /**
           * D-017 (AG-097, CF-066). `undefined` and not `null`: Prisma reads
           * `undefined` as «leave the column alone», which for a fresh row is
           * the NULL these columns default to. `null` would have to be
           * `Prisma.DbNull`, and the JSON null of `Prisma.JsonNull` is a
           * DIFFERENT value — a stored `null` payload would read as «the
           * resource was empty» instead of «there was nothing to record».
           *
           * WHAT IS NOT CHECKED HERE, on purpose: whether this resource type
           * may carry a payload at all. That is
           * `access_audit_payload_only_for_declared_resources`, and it has to
           * be the base's answer — every module writes this table, including
           * from an import or a `psql`, and a guard in this adapter would only
           * cover the callers that came through it.
           */
          before: entry.before as Prisma.InputJsonObject | undefined,
          after: entry.after as Prisma.InputJsonObject | undefined,
        },
      });
    } catch (error) {
      /**
       * SWALLOWED ON PURPOSE, and it is a real trade-off worth stating.
       *
       * Failing the request instead would mean that a database hiccup on the
       * audit table stops a doctor from opening a chart mid-consultation. In a
       * clinic that is the more dangerous failure, so the read proceeds and the
       * gap is shouted about instead.
       *
       * WHERE THIS WOULD BE THE WRONG CHOICE: an EXPORT or a PRINT of clinical
       * data. There the trail is the whole control — an export nobody can
       * account for is exactly what the LOPDP asks us to prevent — and those
       * must fail closed when they cannot be recorded. They do not exist yet;
       * when they do, they must not reuse this path.
       *
       * ONE ACT ALREADY HAS THAT PROPERTY AND ALREADY DOES NOT REUSE IT:
       * `MFA_RESET` (AU-035). Its entry is written inside the reset's own
       * transaction in `PrismaAccountAdminRepository.resetMfa`, so a reset
       * nobody can be held to does not happen. Nothing about the policy below
       * changed for the rest — a chart still opens when this table is having a
       * bad minute.
       *
       * `err` as a field, never interpolated: the logger prunes to an
       * allowlist and interpolation would smuggle data past it.
       */
      this.logger.error(
        {
          err: error,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId,
          action: entry.action,
          user_id: entry.userId,
        },
        'access audit entry could not be recorded',
      );
    }
  }
}
