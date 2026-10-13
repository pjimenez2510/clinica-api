import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  ClinicalHistoryQuery,
  ClinicalHistoryReader,
  HistorySites,
} from '../application/clinical-history.reader';
import type {
  HistoryResult,
  HistoryVisit,
  PrescribedLine,
} from '../domain/clinical-history';

/**
 * AS-200 to AS-207 over PostgreSQL.
 *
 * ⚠️ EVERY READ HANGS OFF `encounter` AND GOES THROUGH `chartScope`. A merge
 * re-points nothing (D-031): by the bare identifier the history would lose
 * the duplicate's laboratory the day admissions repairs it, and say nothing.
 *
 * ⚠️ `patient-chart-scope.spec.ts` DOES NOT GUARD THIS FILE: it scans the
 * tables with a `patient_id` of their own, and `observation_result`,
 * `prescription` and `encounter_vitals` have none. What fails if the scope
 * leaves a `where` is the integration test AS-200 («…y de la que absorbió»,
 * `assistant-clinical-history-http.spec.ts`), as EN-269 does for the vitals.
 */

/** AS-200. The chart and the charts it absorbed, in scope, never annulled. */
function attentionWhere(
  query: ClinicalHistoryQuery,
  where: 'inside' | 'outside' = 'inside',
): Prisma.EncounterWhereInput {
  return {
    ...chartScope(query.patientId),
    ...siteFilter(query.sites, where),
    status: { not: 'ENTERED_IN_ERROR' },
  };
}

function siteFilter(
  sites: HistorySites,
  where: 'inside' | 'outside',
): Prisma.EncounterWhereInput {
  if (sites === 'all') return {};
  return where === 'inside'
    ? { siteId: { in: [...sites] } }
    : { siteId: { notIn: [...sites] } };
}

/**
 * AS-201. A current report — neither superseded by a correction nor
 * cancelled (ORD-151, ORD-152) — of an issued laboratory order. The same
 * predicate `currentReports` applies on the screen of the order.
 */
const resultsWhere = (
  query: ClinicalHistoryQuery,
): Prisma.ObservationResultWhereInput => ({
  report: {
    status: { not: 'CANCELLED' },
    supersededBy: { is: null },
    serviceOrder: {
      status: 'ISSUED',
      category: 'LABORATORY',
      encounter: attentionWhere(query),
    },
  },
});

const RESULT_SELECT = {
  id: true,
  analyteConceptId: true,
  analyteDisplay: true,
  valueNumeric: true,
  valueText: true,
  valueCode: true,
  unit: true,
  referenceLow: true,
  referenceHigh: true,
  referenceText: true,
  criticalLow: true,
  criticalHigh: true,
  abnormalFlag: true,
  observedAt: true,
  report: {
    select: {
      serviceOrder: {
        select: {
          id: true,
          encounterId: true,
          encounter: { select: { patientId: true } },
        },
      },
    },
  },
} satisfies Prisma.ObservationResultSelect;

/** AS-203. Issued: neither a draft, nor discarded, nor annulled (PR-108). */
const prescriptionsWhere = (
  query: ClinicalHistoryQuery,
): Prisma.PrescriptionWhereInput => ({
  status: { in: ['ACTIVE', 'COMPLETED'] },
  issuedAt: { not: null },
  encounter: attentionWhere(query),
});

const decimal = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber();

@Injectable()
export class PrismaClinicalHistoryReader implements ClinicalHistoryReader {
  constructor(private readonly prisma: PrismaService) {}

  async chartIsOpen(patientId: string): Promise<boolean> {
    const chart = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { mergedIntoId: true },
    });
    return chart !== null && chart.mergedIntoId === null;
  }

  async results(
    query: ClinicalHistoryQuery,
    limit: number,
  ): Promise<HistoryResult[]> {
    const rows = await this.prisma.observationResult.findMany({
      where: resultsWhere(query),
      select: RESULT_SELECT,
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      orderId: row.report.serviceOrder.id,
      encounterId: row.report.serviceOrder.encounterId,
      analyteConceptId: row.analyteConceptId,
      analyteDisplay: row.analyteDisplay,
      valueNumeric: decimal(row.valueNumeric),
      valueText: row.valueText,
      valueCode: row.valueCode,
      unit: row.unit,
      referenceLow: decimal(row.referenceLow),
      referenceHigh: decimal(row.referenceHigh),
      referenceText: row.referenceText,
      criticalLow: decimal(row.criticalLow),
      criticalHigh: decimal(row.criticalHigh),
      abnormalFlag: row.abnormalFlag,
      observedAt: row.observedAt,
      // EN-275. `chartScope` reads the absorbed charts too; theirs are marked.
      fromMergedChart:
        row.report.serviceOrder.encounter.patientId !== query.patientId,
    }));
  }

  async countResults(query: ClinicalHistoryQuery): Promise<number> {
    return this.prisma.observationResult.count({ where: resultsWhere(query) });
  }

  async prescribedLines(
    query: ClinicalHistoryQuery,
    limit: number,
  ): Promise<PrescribedLine[]> {
    const rows = await this.prisma.prescription.findMany({
      where: prescriptionsWhere(query),
      select: {
        id: true,
        encounterId: true,
        issuedAt: true,
        encounter: { select: { patientId: true } },
        items: {
          select: {
            conceptId: true,
            genericName: true,
            concentration: true,
            presentation: true,
            doseText: true,
            frequencyText: true,
            durationDays: true,
          },
        },
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.flatMap((row) =>
      row.items.map((item) => ({
        prescriptionId: row.id,
        encounterId: row.encounterId,
        // `prescriptionsWhere` keeps only issued ones.
        issuedAt: row.issuedAt!,
        ...item,
        fromMergedChart: row.encounter.patientId !== query.patientId,
      })),
    );
  }

  async countPrescriptions(query: ClinicalHistoryQuery): Promise<number> {
    return this.prisma.prescription.count({ where: prescriptionsWhere(query) });
  }

  async visits(
    query: ClinicalHistoryQuery,
    limit: number,
  ): Promise<HistoryVisit[]> {
    const rows = await this.prisma.encounter.findMany({
      where: attentionWhere(query),
      select: {
        id: true,
        startedAt: true,
        patientId: true,
        site: { select: { name: true } },
        vitals: { select: { presentingComplaint: true } },
        // EN-041. The frozen code and wording, principal first; three, as
        // the summary (EN-159): the comorbidities that matter at a glance.
        diagnoses: {
          select: { cie10Code: true, cie10Display: true },
          orderBy: [{ rank: 'asc' }],
          take: 3,
        },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      encounterId: row.id,
      startedAt: row.startedAt,
      presentingComplaint: row.vitals?.presentingComplaint ?? null,
      siteName: row.site.name,
      diagnoses: row.diagnoses.map((diagnosis) => ({
        code: diagnosis.cie10Code,
        display: diagnosis.cie10Display,
      })),
      fromMergedChart: row.patientId !== query.patientId,
    }));
  }

  async countVisits(query: ClinicalHistoryQuery): Promise<number> {
    return this.prisma.encounter.count({ where: attentionWhere(query) });
  }

  async hasVisitsOutsideScope(query: ClinicalHistoryQuery): Promise<boolean> {
    if (query.sites === 'all') return false;
    const found = await this.prisma.encounter.findFirst({
      where: attentionWhere(query, 'outside'),
      select: { id: true },
    });
    return found !== null;
  }
}
