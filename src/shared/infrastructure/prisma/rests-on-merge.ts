import type { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../domain/clinic-time';
import type { RestOverlap } from '../../domain/rest-overlap';

/**
 * What a merge of two charts does to the patient's REST CERTIFICATES
 * (PA-062, D-110 §7, provisional until the IESS confirms the procedure).
 *
 * CER-048 refuses, AT ISSUE, a rest that overlaps another rest of the chart
 * when one of the two is a maternity rest. A merge joins two charts that were
 * judged apart, so it can bring together two rests that overlap. D-110 §7: the
 * merge is NOT refused —it corrects a duplicated identity— and says so, so the
 * one who does not belong is revoked from its attention.
 *
 * IN `shared` AND NOT IN `patients`: `medical_certificate` belongs to
 * `certificates`, and no module reads another module's table through an
 * import (see the header of `waitlist-follows-merge.ts`).
 */

/**
 * Takes the rest locks of both charts, in a fixed order so two merges cannot
 * deadlock each other. The key is built IN THE DATABASE from `uuid::text`,
 * exactly as `medical_certificate_issue_rules` and the certificates repository
 * build it: an id that arrives in capitals would otherwise hash to another
 * lock and wait for nobody.
 *
 * Called FIRST in the transaction of a merge or of its undo, before the chart
 * row is locked: an issue takes its rest lock and only then touches the
 * patient row (its foreign key), so taking them in the same order here leaves
 * no cycle. An issue on either chart waits, and then reads the chart as the
 * merge or the undo left it.
 */
export async function lockRestsOfCharts(
  tx: Prisma.TransactionClient,
  chartIds: readonly string[],
): Promise<void> {
  for (const id of [...chartIds].map((id) => id.toLowerCase()).sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('medical_certificate_rest:' || ${id}::uuid::text, 0))`;
  }
}

/** PA-062. One side of an overlap, as the database gives it. */
interface OverlapRow {
  absorbedNumber: number;
  absorbedFrom: Date;
  absorbedTo: Date;
  absorbedMaternity: boolean;
  survivingNumber: number;
  survivingFrom: Date;
  survivingTo: Date;
  survivingMaternity: boolean;
}

const dateOf = (value: Date) =>
  value.toISOString().slice(0, 10) as ClinicalDate;

/**
 * The pairs of rests, one from each chart, neither revoked, that overlap with
 * one of the two a maternity rest — what CER-048 would have refused at issue.
 * The absorbed chart never holds others (no chains, PA-046); the survivor's
 * side is the survivor and what it absorbed before. Ordered so the notice
 * reads the same every time.
 */
export async function maternityRestOverlapsOnMerge(
  tx: Prisma.TransactionClient,
  charts: { absorbedChartId: string; survivingChartId: string },
): Promise<RestOverlap[]> {
  const rows = await tx.$queryRaw<OverlapRow[]>`
    SELECT absorbed.number AS "absorbedNumber",
           absorbed.rest_from AS "absorbedFrom",
           absorbed.rest_to AS "absorbedTo",
           absorbed.contingency_type = 'MATERNITY' AS "absorbedMaternity",
           surviving.number AS "survivingNumber",
           surviving.rest_from AS "survivingFrom",
           surviving.rest_to AS "survivingTo",
           surviving.contingency_type = 'MATERNITY' AS "survivingMaternity"
      FROM medical_certificate AS absorbed
      JOIN medical_certificate AS surviving
        ON daterange(absorbed.rest_from, absorbed.rest_to, '[]')
           && daterange(surviving.rest_from, surviving.rest_to, '[]')
     WHERE absorbed.patient_id = ${charts.absorbedChartId}::uuid
       AND surviving.patient_id IN (
             SELECT id FROM patient
              WHERE (id = ${charts.survivingChartId}::uuid
                     OR merged_into_id = ${charts.survivingChartId}::uuid)
                AND id <> ${charts.absorbedChartId}::uuid)
       AND absorbed.type = 'MEDICAL_REST' AND surviving.type = 'MEDICAL_REST'
       AND absorbed.revoked_at IS NULL AND surviving.revoked_at IS NULL
       AND absorbed.rest_to >= absorbed.rest_from
       AND surviving.rest_to >= surviving.rest_from
       AND (absorbed.contingency_type = 'MATERNITY'
            OR surviving.contingency_type = 'MATERNITY')
     ORDER BY absorbed.rest_from, absorbed.number, surviving.rest_from, surviving.number
  `;
  return rows.map((row) => ({
    absorbed: {
      number: row.absorbedNumber,
      from: dateOf(row.absorbedFrom),
      to: dateOf(row.absorbedTo),
      maternity: row.absorbedMaternity,
    },
    surviving: {
      number: row.survivingNumber,
      from: dateOf(row.survivingFrom),
      to: dateOf(row.survivingTo),
      maternity: row.survivingMaternity,
    },
  }));
}
