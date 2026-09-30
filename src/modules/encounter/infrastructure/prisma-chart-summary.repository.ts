import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  ChartSummaryQuery,
  ChartSummaryRepository,
  PreviousEncounterSummary,
  SummaryVitals,
} from '../domain/chart-summary.repository';
import type { SiteScopeFilter } from '../domain/encounter.repository';

/**
 * EN-159. The consultation's view of the history, in ONE statement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ `chartScope` AND NOT `patientId`, AND HERE IT MATTERS MORE THAN ANYWHERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When two charts of the same person are merged, a read by the bare
 * `patient_id` returns half a clinical history and **neither fails nor warns
 * — it simply omits**. On a listing screen that is a missing row somebody
 * notices; inside a consultation it is an allergy that does not appear and a
 * previous diagnosis nobody sees. It is the exact shape of defect PA-009, and
 * `patient-chart-scope.spec.ts` walks this file and fails the build if the
 * scope ever leaves the `where`.
 *
 * ⚠️ AND THE NESTED SELECTS BELOW HANG OFF `encounter`, NOT OFF `patient`.
 * That distinction is what makes them safe: a nested `select` of a HISTORY
 * relation off a patient row has to carry `mergedFrom` with the same relation
 * under it, and the analyser enforces exactly that. `diagnoses` and `vitals`
 * belong to the attention, which the scope has already resolved.
 */

/**
 * EN-041, EN-043. The diagnoses of one attention, principal first.
 *
 * ⚠️ THE FROZEN CODE AND NOT THE CONCEPT (EN-041). `trg_diagnosis_snapshot`
 * keeps `cie10_code` and `cie10_display` in step with the concept; reading
 * through the relation instead would make a summary of a 2026 consultation
 * change its wording the day the catalogue is reloaded.
 *
 * BOUNDED AT THREE. The RDACAA's own form has three boxes, a summary is not
 * the record — `GET /encounters/:id/diagnoses` serves all of them, uncut
 * (EN-047) — and the comorbidities that matter for reading a history at a
 * glance are the first ones by rank. Five previous attentions with eight
 * diagnoses each is the dump §7 bis says makes people stop reading.
 */
const SUMMARY_DIAGNOSES = {
  select: {
    cie10Code: true,
    cie10Display: true,
    certainty: true,
    rank: true,
  },
  orderBy: [{ rank: 'asc' }],
  take: 3,
} satisfies Prisma.Encounter$diagnosesArgs;

/** EN-068. The five measurements a consultation looks back at. */
const SUMMARY_VITALS = {
  select: {
    weightKg: true,
    heightCm: true,
    bmi: true,
    systolicBp: true,
    diastolicBp: true,
    temperatureC: true,
    measuredAt: true,
  },
} satisfies Prisma.Encounter$vitalsArgs;

const SUMMARY_SELECT = {
  id: true,
  siteId: true,
  startedAt: true,
  status: true,
  careModality: true,
  careSetting: true,
  visitSequence: true,
  dischargeCondition: true,
  diagnoses: SUMMARY_DIAGNOSES,
  vitals: SUMMARY_VITALS,
} satisfies Prisma.EncounterSelect;

/** The row `SUMMARY_SELECT` yields, derived from it so the two cannot drift. */
type SummaryRow = Prisma.EncounterGetPayload<{ select: typeof SUMMARY_SELECT }>;

/**
 * EN-159 over PostgreSQL. The list and the count share one predicate
 * (`previousEncountersWhere`), so «5 de 24» always reconciles.
 */
@Injectable()
export class PrismaChartSummaryRepository implements ChartSummaryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** EN-159. The chart's previous attentions, newest first, bounded. */
  async previousEncounters(
    query: ChartSummaryQuery,
  ): Promise<PreviousEncounterSummary[]> {
    const rows = await this.prisma.encounter.findMany({
      where: previousEncountersWhere(query),
      select: SUMMARY_SELECT,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });

    return rows.map(toPreviousEncounter);
  }

  /**
   * EN-159. How many there are in all, so a truncation is visible.
   *
   * THE SAME `where` AS THE LIST, deliberately: a count that answered a
   * slightly different question — including today's attention, or ignoring the
   * site scope — would produce «5 de 24» on a chart with 23, and a number a
   * reader cannot reconcile is worse than no number.
   */
  async countEncounters(query: ChartSummaryQuery): Promise<number> {
    return this.prisma.encounter.count({
      where: previousEncountersWhere(query),
    });
  }
}

/**
 * The predicate both statements share: the chart AND the charts it absorbed,
 * inside the caller's site scope, minus the attention being conducted.
 *
 * ⚠️ WRITTEN ONCE BECAUSE THE COUNT AND THE LIST MUST NOT DRIFT, and because
 * `chartScope` written twice is `chartScope` forgotten once.
 */
function previousEncountersWhere(
  query: ChartSummaryQuery,
): Prisma.EncounterWhereInput {
  return {
    ...chartScope(query.patientId),
    ...siteFilter(query.sites),
    ...(query.excludeEncounterId === undefined
      ? {}
      : { id: { not: query.excludeEncounterId } }),
  };
}

/**
 * EN-121. The caller's resolved scope as a `where` fragment.
 *
 * `'all'` yields no filter, and an empty list never reaches here: `siteScope`
 * throws `SITE_SCOPE_DENIED` when the caller holds the permission at no site,
 * precisely so «no filter to apply» can never be spelled as «every site».
 *
 * ⚠️ A PREVIOUS ATTENTION AT A SITE THE CALLER CANNOT SEE IS OMITTED, AND THAT
 * IS THE DECISION EN-121 ALREADY TOOK for `historyOf`. It is a real cost — a
 * doctor at the southern branch does not see what was diagnosed downtown — and
 * it is the same cost the attention listing already pays. Widening it here
 * would make the summary a way around the site scope, which is precisely the
 * kind of quiet hole a screen-level convenience opens.
 */
function siteFilter(sites: SiteScopeFilter): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** One previous attention: its top diagnoses by rank and its vitals, nothing else. */
function toPreviousEncounter(row: SummaryRow): PreviousEncounterSummary {
  return {
    id: row.id,
    siteId: row.siteId,
    startedAt: row.startedAt,
    status: row.status,
    careModality: row.careModality,
    careSetting: row.careSetting,
    visitSequence: row.visitSequence,
    dischargeCondition: row.dischargeCondition,
    diagnoses: row.diagnoses.map((diagnosis) => ({
      cie10Code: diagnosis.cie10Code,
      cie10Display: diagnosis.cie10Display,
      certainty: diagnosis.certainty,
      rank: diagnosis.rank,
    })),
    vitals: row.vitals === null ? null : toSummaryVitals(row.vitals),
  };
}

/** `Decimal` out, plain numbers in; `null` stays `null` and means «no consta». */
function toSummaryVitals(
  row: NonNullable<SummaryRow['vitals']>,
): SummaryVitals {
  const decimal = (value: Prisma.Decimal | null): number | null =>
    value === null ? null : value.toNumber();

  return {
    weightKg: decimal(row.weightKg),
    heightCm: decimal(row.heightCm),
    // EN-061. The figure `trg_encounter_vitals_bmi` stored, never one derived
    // here: a summary that computed it could disagree with the record it
    // summarises.
    bmi: decimal(row.bmi),
    systolicBp: row.systolicBp,
    diastolicBp: row.diastolicBp,
    temperatureC: decimal(row.temperatureC),
    measuredAt: row.measuredAt,
  };
}
