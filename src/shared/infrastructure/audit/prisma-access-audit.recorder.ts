import { Injectable } from '@nestjs/common';
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
