import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { SiteScopeFilter } from '../domain/encounter.repository';
import type {
  BloodPressureReference,
  VitalsHistoryQuery,
  VitalsHistoryRepository,
  VitalsTaking,
} from '../domain/vitals-history.repository';

/**
 * EN-269 to EN-272 over PostgreSQL.
 *
 * ⚠️ THROUGH `chartScope` AND NOT `patientId`. A merge re-points nothing
 * (D-031), so a read by the bare identifier would draw half a weight curve
 * the day admissions repairs a duplicate — and say nothing. The filter
 * hangs off `encounter`, which owns the taking.
 *
 * ⚠️ `patient-chart-scope.spec.ts` DOES NOT GUARD THIS FILE: it scans the
 * tables with a `patient_id` of their own, and `encounter_vitals` has none.
 * What fails if the scope leaves the `where` is the integration test EN-269
 * («…y de la que absorbió», `encounter-vitals-history.spec.ts`).
 */
const TAKING_SELECT = {
  encounterId: true,
  measuredAt: true,
  weightKg: true,
  heightCm: true,
  heightPosition: true,
  headCircumferenceCm: true,
  abdominalCircumferenceCm: true,
  bmi: true,
  systolicBp: true,
  diastolicBp: true,
  heartRate: true,
  respiratoryRate: true,
  temperatureC: true,
  oxygenSaturation: true,
  hemoglobinGDl: true,
  hemoglobinCorrectedGDl: true,
  encounter: {
    select: {
      siteId: true,
      patientId: true,
      ageYears: true,
      ageMonths: true,
      ageDays: true,
    },
  },
} satisfies Prisma.EncounterVitalsSelect;

/** EN-269. The columns that are a figure: a taking has at least one. */
const FIGURES = [
  'weightKg',
  'heightCm',
  'headCircumferenceCm',
  'abdominalCircumferenceCm',
  'systolicBp',
  'diastolicBp',
  'heartRate',
  'respiratoryRate',
  'temperatureC',
  'oxygenSaturation',
  'hemoglobinGDl',
  'hemoglobinCorrectedGDl',
] as const satisfies readonly (keyof Prisma.EncounterVitalsWhereInput)[];

type TakingRow = Prisma.EncounterVitalsGetPayload<{
  select: typeof TAKING_SELECT;
}>;

@Injectable()
export class PrismaVitalsHistoryRepository implements VitalsHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async takings(query: VitalsHistoryQuery): Promise<VitalsTaking[]> {
    const rows = await this.prisma.encounterVitals.findMany({
      where: takingsWhere(query),
      select: TAKING_SELECT,
      orderBy: [{ measuredAt: 'desc' }, { encounterId: 'desc' }],
      take: query.limit,
    });
    return rows.map((row) => toTaking(row, query.patientId));
  }

  /** The same `where` as the list, so «100 de 130» always reconciles. */
  async countTakings(
    query: Omit<VitalsHistoryQuery, 'limit'>,
  ): Promise<number> {
    return this.prisma.encounterVitals.count({ where: takingsWhere(query) });
  }

  /**
   * EN-276. The list's predicate with the site filter turned inside out: a
   * row with only the reason for the visit, or of an annulled attention, is
   * no taking that is missing from the curve.
   */
  async hasTakingsOutsideScope(
    query: Omit<VitalsHistoryQuery, 'limit'>,
  ): Promise<boolean> {
    if (query.sites === 'all') return false;
    const found = await this.prisma.encounterVitals.findFirst({
      where: takingsWhere(query, 'outside'),
      select: { encounterId: true },
    });
    return found !== null;
  }

  /**
   * EN-272. THE PAIR OF ONE SITE: the active site in scope with the lowest
   * systolic line, its diastolic with it. A chart has one line and the
   * strictest flags too much rather than too little — but the minimum of each
   * column on its own would draw a pair no site configured (130/90 and 140/80
   * would become 130/80). A closed site's parameters are nobody's anymore and
   * do not count. With one site — the common clinic — it is that site's.
   */
  async bloodPressureReference(
    sites: SiteScopeFilter,
  ): Promise<BloodPressureReference | null> {
    const lowest = await this.prisma.siteParameter.findFirst({
      where: {
        site: { active: true },
        ...(sites === 'all' ? {} : { siteId: { in: [...sites] } }),
      },
      orderBy: [
        { bpReferenceSystolic: 'asc' },
        { bpReferenceDiastolic: 'asc' },
      ],
      select: { bpReferenceSystolic: true, bpReferenceDiastolic: true },
    });
    return lowest === null
      ? null
      : {
          systolic: lowest.bpReferenceSystolic,
          diastolic: lowest.bpReferenceDiastolic,
        };
  }
}

/**
 * The chart and the charts it absorbed, inside the caller's sites, minus the
 * annulled attentions (EN-270): an attention opened on the wrong patient
 * holds somebody else's weight.
 */
function takingsWhere(
  query: Omit<VitalsHistoryQuery, 'limit'>,
  where: 'inside' | 'outside' = 'inside',
): Prisma.EncounterVitalsWhereInput {
  const sites =
    query.sites === 'all'
      ? {}
      : where === 'inside'
        ? { siteId: { in: [...query.sites] } }
        : { siteId: { notIn: [...query.sites] } };
  return {
    // EN-269. A row with only the reason for the visit (EN-163) is no taking:
    // it would spend a place of the hundred and a unit of «de 130».
    OR: FIGURES.map((figure) => ({ [figure]: { not: null } })),
    encounter: {
      ...chartScope(query.patientId),
      ...sites,
      status: { not: 'ENTERED_IN_ERROR' },
    },
  };
}

/** `Decimal` out, plain numbers in; `null` stays `null` and means «no consta». */
function toTaking(row: TakingRow, chartId: string): VitalsTaking {
  const decimal = (value: Prisma.Decimal | null): number | null =>
    value === null ? null : value.toNumber();

  return {
    encounterId: row.encounterId,
    siteId: row.encounter.siteId,
    measuredAt: row.measuredAt,
    ageYears: row.encounter.ageYears,
    ageMonths: row.encounter.ageMonths,
    ageDays: row.encounter.ageDays,
    weightKg: decimal(row.weightKg),
    heightCm: decimal(row.heightCm),
    heightPosition: row.heightPosition,
    headCircumferenceCm: decimal(row.headCircumferenceCm),
    abdominalCircumferenceCm: decimal(row.abdominalCircumferenceCm),
    bmi: decimal(row.bmi),
    systolicBp: row.systolicBp,
    diastolicBp: row.diastolicBp,
    heartRate: row.heartRate,
    respiratoryRate: row.respiratoryRate,
    temperatureC: decimal(row.temperatureC),
    oxygenSaturation: row.oxygenSaturation,
    hemoglobinGDl: decimal(row.hemoglobinGDl),
    hemoglobinCorrectedGDl: decimal(row.hemoglobinCorrectedGDl),
    // EN-275. `chartScope` reads the absorbed charts too; theirs are marked.
    fromMergedChart: row.encounter.patientId !== chartId,
  };
}
