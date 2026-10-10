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
 * the day admissions repairs a duplicate — and say nothing.
 * `patient-chart-scope.spec.ts` walks this file and fails the build if the
 * scope ever leaves the `where`. The filter hangs off `encounter`, which owns
 * the taking.
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
    select: { siteId: true, ageYears: true, ageMonths: true, ageDays: true },
  },
} satisfies Prisma.EncounterVitalsSelect;

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
    return rows.map(toTaking);
  }

  /** The same `where` as the list, so «100 de 130» always reconciles. */
  async countTakings(
    query: Omit<VitalsHistoryQuery, 'limit'>,
  ): Promise<number> {
    return this.prisma.encounterVitals.count({ where: takingsWhere(query) });
  }

  /**
   * EN-272. The LOWEST line of the sites in scope, each figure on its own: a
   * chart has one line, and the strictest one flags too much rather than too
   * little. With one site — the common clinic — it is that site's.
   */
  async bloodPressureReference(
    sites: SiteScopeFilter,
  ): Promise<BloodPressureReference | null> {
    const lowest = await this.prisma.siteParameter.aggregate({
      where: sites === 'all' ? {} : { siteId: { in: [...sites] } },
      _min: { bpReferenceSystolic: true, bpReferenceDiastolic: true },
    });
    const systolic = lowest._min.bpReferenceSystolic;
    const diastolic = lowest._min.bpReferenceDiastolic;
    return systolic === null || diastolic === null
      ? null
      : { systolic, diastolic };
  }
}

/**
 * The chart and the charts it absorbed, inside the caller's sites, minus the
 * annulled attentions (EN-270): an attention opened on the wrong patient
 * holds somebody else's weight.
 */
function takingsWhere(
  query: Omit<VitalsHistoryQuery, 'limit'>,
): Prisma.EncounterVitalsWhereInput {
  return {
    encounter: {
      ...chartScope(query.patientId),
      ...(query.sites === 'all' ? {} : { siteId: { in: [...query.sites] } }),
      status: { not: 'ENTERED_IN_ERROR' },
    },
  };
}

/** `Decimal` out, plain numbers in; `null` stays `null` and means «no consta». */
function toTaking(row: TakingRow): VitalsTaking {
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
  };
}
