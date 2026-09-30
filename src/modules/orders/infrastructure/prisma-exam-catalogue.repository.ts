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
 * ⚠️ READ-ONLY, and there is no write anywhere in this class. Creating an exam
 * or an analyte is a CATALOGUE operation with three rules this system already
 * implements once: versioned whole replacement, retired codes disabled and
 * never deleted, validity per version. A second mechanism here is how two
 * catalogues of one thing start disagreeing.
 *
 * ⚠️ AND `billable_service_id` IS NEVER SELECTED (ORD-002). The exam points at
 * what the line is invoiced under; the AMOUNT is a price list, per payer, per
 * period, in `billing`. A column that is never loaded cannot reach a clinical
 * screen.
 */

const ANALYTE_SELECT = {
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

type AnalyteRow = Prisma.AnalyteDefinitionGetPayload<{
  select: typeof ANALYTE_SELECT;
}>;

const EXAM_SELECT = {
  id: true,
  code: true,
  name: true,
  form010Section: true,
  specimenType: true,
  patientPreparation: true,
  turnaroundHours: true,
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

type ExamRow = Prisma.ExamDefinitionGetPayload<{ select: typeof EXAM_SELECT }>;

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

function toExamView(row: ExamRow): ExamDefinitionView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    form010Section: row.form010Section,
    specimenType: row.specimenType,
    patientPreparation: row.patientPreparation,
    turnaroundHours: row.turnaroundHours,
    performedExternally: row.performedExternally,
    externalLabName: row.externalLabName,
    analytes: row.analytes.map((entry) => ({
      analyte: toAnalyte(entry.analyteDefinition),
      position: entry.position,
      isReflex: entry.isReflex,
    })),
  };
}

function toAnalyte(row: AnalyteRow): AnalyteDefinition {
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
