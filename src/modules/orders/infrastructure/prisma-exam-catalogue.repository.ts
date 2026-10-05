import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  ExamCatalogueRepository,
  ExamDefinitionView,
} from '../domain/exam-catalogue.repository';
import type {
  AnalyteDefinition,
  AnalyteValueType,
  PatientSex,
  RangeKind,
  ReferenceRange,
} from '../domain/analyte';

/**
 * The two catalogues — orderable and resultable — as the domain reads them.
 *
 * ⚠️ READ-ONLY, and there is no write anywhere in this class: the clinic
 * writes the catalogue through `PrismaExamAdministrationRepository`
 * (ORD-103 to ORD-111), with `catalog:manage`, and ordering never does.
 *
 * ⚠️ AND `billable_service_id` IS NEVER SELECTED (ORD-002). The exam points at
 * what the line is invoiced under; the AMOUNT is a price list, per payer, per
 * period, in `billing`. A column that is never loaded cannot reach a clinical
 * screen.
 */

/** An analyte with every range it declares, of whatever kind. */
export const ANALYTE_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  valueType: true,
  decimals: true,
  allowedValues: true,
  referenceRanges: {
    select: {
      rangeKind: true,
      sex: true,
      ageMinDays: true,
      ageMaxDays: true,
      low: true,
      high: true,
      text: true,
    },
  },
} satisfies Prisma.AnalyteDefinitionSelect;

/** The shape `ANALYTE_SELECT` produces. */
export type AnalyteRow = Prisma.AnalyteDefinitionGetPayload<{
  select: typeof ANALYTE_SELECT;
}>;

/** An exam and its analytes, without `billable_service_id` (see above). */
export const EXAM_SELECT = {
  id: true,
  code: true,
  name: true,
  category: true,
  form010Section: true,
  specimenType: true,
  patientPreparation: true,
  turnaroundHours: true,
  tariffCode: true,
  performedExternally: true,
  externalLabName: true,
  analytes: {
    // ORD-011. STORED ORDER, never alphabetical: a laboratory report read out
    // of order is a report nobody can scan.
    orderBy: { position: 'asc' },
    select: {
      position: true,
      isReflex: true,
      analyteDefinition: { select: ANALYTE_SELECT },
    },
  },
} satisfies Prisma.ExamDefinitionSelect;

/** The shape `EXAM_SELECT` produces. */
export type ExamRow = Prisma.ExamDefinitionGetPayload<{
  select: typeof EXAM_SELECT;
}>;

/** The `ExamCatalogueRepository` adapter; it only reads. */
@Injectable()
export class PrismaExamCatalogueRepository implements ExamCatalogueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ORD-010 to ORD-012. Everything orderable today. */
  async active(): Promise<ExamDefinitionView[]> {
    const rows = await this.prisma.examDefinition.findMany({
      where: { active: true },
      orderBy: [{ form010Section: 'asc' }, { name: 'asc' }],
      select: EXAM_SELECT,
    });
    return rows.map(toExamView);
  }

  /** ORD-003. Only the active ones: a short answer refuses the whole order. */
  async activeByIds(ids: readonly string[]): Promise<ExamDefinitionView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.examDefinition.findMany({
      where: { id: { in: [...ids] }, active: true },
      select: EXAM_SELECT,
    });
    return rows.map(toExamView);
  }

  /**
   * ORD-039, ORD-040. By frozen code, ACTIVE OR NOT.
   *
   * A result can arrive weeks after the clinic disabled the exam, and the line
   * that asked for it froze the code precisely so that resolving it later does
   * not depend on today's catalogue.
   */
  async byCodes(codes: readonly string[]): Promise<ExamDefinitionView[]> {
    if (codes.length === 0) return [];
    const rows = await this.prisma.examDefinition.findMany({
      where: { code: { in: [...codes] } },
      select: EXAM_SELECT,
    });
    return rows.map(toExamView);
  }

  /** ORD-042. Fewer rows than ids means one determination is not catalogued. */
  async analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.analyteDefinition.findMany({
      where: { id: { in: [...ids] }, active: true },
      select: ANALYTE_SELECT,
    });
    return rows.map(toAnalyte);
  }
}

/** Row to view, analytes in their stored position. */
export function toExamView(row: ExamRow): ExamDefinitionView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    form010Section: row.form010Section,
    specimenType: row.specimenType,
    patientPreparation: row.patientPreparation,
    turnaroundHours: row.turnaroundHours,
    tariffCode: row.tariffCode,
    performedExternally: row.performedExternally,
    externalLabName: row.externalLabName,
    analytes: row.analytes.map((entry) => ({
      analyte: toAnalyte(entry.analyteDefinition),
      position: entry.position,
      isReflex: entry.isReflex,
    })),
  };
}

/** Row to domain analyte, with `allowed_values` and the ranges parsed. */
export function toAnalyte(row: AnalyteRow): AnalyteDefinition {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    // The column is a `varchar(16)` guarded by
    // `analyte_definition_value_type_is_known`, so the CHECK is the closed
    // union and this cast asserts what the database already enforces.
    valueType: row.valueType as AnalyteValueType,
    decimals: row.decimals,
    allowedValues: toAllowedValues(row.allowedValues),
    ranges: row.referenceRanges.map(toRange),
  };
}

/**
 * ORD-033. `allowed_values` is `jsonb` and therefore `unknown` from here.
 *
 * ⚠️ ANYTHING THAT IS NOT AN ARRAY OF STRINGS BECOMES `null`, «no hay lista»,
 * rather than an empty list. An empty list would mean «ningún valor es
 * admisible» and would make the analyte untranscribable; `null` means the
 * catalogue has not stated the answers yet, which is the honest reading of a
 * malformed payload and the one ORD-033 already covers.
 */
function toAllowedValues(value: Prisma.JsonValue): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === 'string'); // prettier-ignore
  return strings.length === value.length && strings.length > 0 ? strings : null;
}

/**
 * Row to domain range. The kind cast leans on
 * `analyte_reference_range_kind_is_known`; `sex` is a bare `varchar(16)` with no
 * CHECK in the migrations, so the database does not guard that cast.
 */
function toRange(row: {
  rangeKind: string;
  sex: string | null;
  ageMinDays: number | null;
  ageMaxDays: number | null;
  low: Prisma.Decimal | null;
  high: Prisma.Decimal | null;
  text: string | null;
}): ReferenceRange {
  return {
    rangeKind: row.rangeKind as RangeKind,
    sex: row.sex as PatientSex | null,
    ageMinDays: row.ageMinDays,
    ageMaxDays: row.ageMaxDays,
    /**
     * `Decimal(14,4)` to `number`, and it is safe HERE and not everywhere:
     * these are laboratory bounds, not money. The comparison that follows is
     * `<` and `>` against a reading of the same magnitude, and nothing is ever
     * summed — which is where binary floating point actually bites. Money in
     * this system never leaves `Decimal`, and nothing in this module handles
     * money at all (ORD-002).
     */
    low: row.low === null ? null : row.low.toNumber(),
    high: row.high === null ? null : row.high.toNumber(),
    text: row.text,
  };
}
