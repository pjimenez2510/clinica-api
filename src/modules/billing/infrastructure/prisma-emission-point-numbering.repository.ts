import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { NumberingBelowUsedError } from '../domain/billing.errors';
import type {
  NumberingRecord,
  VoucherType,
} from '../domain/emission-point-numbering';
import type {
  EmissionPointNumberingRepository,
  NumberingFix,
} from '../domain/emission-point-numbering.repository';

interface NumberingRow {
  emission_point_id: string;
  code: string;
  active: boolean;
  document_type: VoucherType;
  used_up_to: number;
  next_sequential: number | null;
  previous_system_last: number | null;
  reason: string | null;
  changed_at: Date | null;
  changed_by: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** BI-306 to BI-309. The floor lives in `emission_point_numbering`. */
@Injectable()
export class PrismaEmissionPointNumberingRepository implements EmissionPointNumberingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForSite(siteId: string): Promise<NumberingRecord[]> {
    // The largest used comes from the same function the database numbers
    // with, so the screen never says a number the issuance would not give.
    const rows = await this.prisma.$queryRaw<NumberingRow[]>`
      SELECT ep."id" AS "emission_point_id", ep."code", ep."active",
             t."type" AS "document_type",
             emission_point_used_sequential(ep."id", t."type"::char(2)) AS "used_up_to",
             n."next_sequential", n."previous_system_last", n."reason",
             n."changed_at", n."changed_by", u."first_name", u."last_name"
        FROM "emission_point" ep
       CROSS JOIN (VALUES ('01'), ('04')) AS t("type")
        LEFT JOIN "emission_point_numbering" n
               ON n."emission_point_id" = ep."id" AND n."document_type" = t."type"
        LEFT JOIN "app_user" u ON u."id" = n."changed_by"
       WHERE ep."site_id" = ${siteId}::uuid
       ORDER BY ep."code", t."type"`;
    return rows.map((row) => ({
      emissionPointId: row.emission_point_id,
      emissionPointCode: row.code,
      emissionPointActive: row.active,
      documentType: row.document_type,
      usedUpTo: Number(row.used_up_to),
      nextSequential: row.next_sequential,
      previousSystemLast: row.previous_system_last,
      lastChange:
        row.changed_at === null || row.changed_by === null
          ? null
          : {
              at: row.changed_at,
              byId: row.changed_by,
              byName: `${row.first_name} ${row.last_name}`,
              reason: row.reason ?? '',
            },
    }));
  }

  async siteOf(emissionPointId: string): Promise<string | null> {
    const point = await this.prisma.emissionPoint.findUnique({
      where: { id: emissionPointId },
      select: { siteId: true },
    });
    return point?.siteId ?? null;
  }

  async fix(change: NumberingFix): Promise<void> {
    try {
      // UPDATE first and INSERT only for a new row: with `ON CONFLICT` the
      // INSERT trigger would judge the row as proposed, an old floor already
      // overtaken included, before the UPDATE that keeps it (BI-307).
      const changedAt = new Date();
      const updated = await this.prisma.$executeRaw`
        UPDATE "emission_point_numbering"
           SET "next_sequential" = ${change.nextSequential},
               "previous_system_last" = ${change.previousSystemLast},
               "reason" = ${change.reason},
               "changed_by" = ${change.changedById}::uuid,
               "changed_at" = ${changedAt}
         WHERE "emission_point_id" = ${change.emissionPointId}::uuid
           AND "document_type" = ${change.documentType}`;
      if (updated === 0) {
        await this.prisma.$executeRaw`
          INSERT INTO "emission_point_numbering"
            ("emission_point_id", "document_type", "next_sequential",
             "previous_system_last", "reason", "changed_by", "changed_at")
          VALUES (${change.emissionPointId}::uuid, ${change.documentType},
                  ${change.nextSequential}, ${change.previousSystemLast},
                  ${change.reason}, ${change.changedById}::uuid, ${changedAt})`;
      }
    } catch (error) {
      // BI-307. The trigger decided under the point's lock; what it saw is
      // read again only to say it.
      if (
        String((error as Error).message).includes(
          'emission_point_numbering_not_below_used',
        )
      ) {
        const [{ used }] = await this.prisma.$queryRaw<[{ used: number }]>`
          SELECT emission_point_used_sequential(
                   ${change.emissionPointId}::uuid, ${change.documentType}::char(2)) AS "used"`;
        throw new NumberingBelowUsedError(Number(used));
      }
      throw error;
    }
  }
}
