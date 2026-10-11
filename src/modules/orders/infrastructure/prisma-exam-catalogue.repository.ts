import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  orderCategoryOf,
  type ExamCatalogueRepository,
  type OrderableExamView,
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
 * ⚠️ READ-ONLY, and there is no write anywhere in this class: billing writes
 * the service and its order extension (BI-280, BI-284), the structure is
 * written through `PrismaExamAdministrationRepository` (ORD-105), and
 * ordering never writes.
 *
 * ADR-013. An orderable is a `service` with a `service_exam`: the exam has no
 * row of its own, so its id, code, name and MSP code are the service's.
 *
 * ⚠️ AND NO AMOUNT IS EVER SELECTED (ORD-002). The service is read for its
 * name, code, kind and MSP code; the AMOUNT is a price list, per payer, per
 * period, in `billing`. A column that is never loaded cannot reach a clinical
 * screen.
 */

/**
 * An analyte with every range IN FORCE, of whatever kind.
 *
 * ⚠️ `valid_to IS NULL` AND NOTHING ELSE (ORD-114). Everything that classifies
 * a value or edits the catalogue reads through here, and a closed row that
 * still counted would sit beside its replacement as two equally specific
 * ranges — the flag would depend on the order the rows came back in. «In
 * force» is the absence of a closing instant, not a comparison with the
 * clock: a clock that is off cannot leave a patient without a range.
 */
export const ANALYTE_SELECT = {
  id: true,
  code: true,
  name: true,
  unit: true,
  valueType: true,
  decimals: true,
  allowedValues: true,
  referenceRanges: {
    where: { validTo: null },
    // A STABLE ORDER, not the rows' age: editing one range opens a newer row
    // (ORD-113), and the editor's rows must not jump on every save.
    orderBy: [
      { rangeKind: 'desc' },
      { sex: { sort: 'asc', nulls: 'first' } },
      { ageMinDays: { sort: 'asc', nulls: 'first' } },
      { validFrom: 'asc' },
    ],
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

/** A service with its order extension and analytes; never an amount. */
export const EXAM_SELECT = {
  id: true,
  code: true,
  name: true,
  kind: true,
  mspCode: true,
  active: true,
  exam: {
    select: {
      form010Section: true,
      specimenType: true,
      patientPreparation: true,
      turnaroundHours: true,
      requiresFasting: true,
      fastingHours: true,
      performedExternally: true,
      externalLabName: true,
      externalLabCode: true,
      analytes: {
        // ORD-011. STORED ORDER, never alphabetical: a laboratory report read
        // out of order is a report nobody can scan.
        orderBy: { position: 'asc' },
        select: {
          position: true,
          isReflex: true,
          analyteDefinition: { select: ANALYTE_SELECT },
        },
      },
    },
  },
} satisfies Prisma.ServiceSelect;

/** The shape `EXAM_SELECT` produces. */
export type ExamRow = Prisma.ServiceGetPayload<{
  select: typeof EXAM_SELECT;
}>;

/**
 * BI-284. An orderable: a service with an order extension. The kinds that
 * admit one are guarded by `trg_service_exam_kind_admits`.
 */
export const ORDERABLE = { exam: { isNot: null } } satisfies Prisma.ServiceWhereInput; // prettier-ignore

/** The `ExamCatalogueRepository` adapter; it only reads. */
@Injectable()
export class PrismaExamCatalogueRepository implements ExamCatalogueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ORD-010 to ORD-012. Everything orderable today. */
  async active(): Promise<OrderableExamView[]> {
    const rows = await this.prisma.service.findMany({
      where: { ...ORDERABLE, active: true },
      orderBy: [{ exam: { form010Section: 'asc' } }, { name: 'asc' }],
      select: EXAM_SELECT,
    });
    return toExamViews(rows);
  }

  /** ORD-003. Only the active ones: a short answer refuses the whole order. */
  async activeByIds(ids: readonly string[]): Promise<OrderableExamView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.service.findMany({
      where: { ...ORDERABLE, id: { in: [...ids] }, active: true },
      select: EXAM_SELECT,
    });
    return toExamViews(rows);
  }

  /**
   * ORD-039, ORD-040. By frozen code, ACTIVE OR NOT.
   *
   * A result can arrive weeks after the clinic disabled the exam, and the line
   * that asked for it froze the code precisely so that resolving it later does
   * not depend on today's catalogue.
   */
  async byCodes(codes: readonly string[]): Promise<OrderableExamView[]> {
    if (codes.length === 0) return [];
    const rows = await this.prisma.service.findMany({
      where: { ...ORDERABLE, code: { in: [...codes] } },
      select: EXAM_SELECT,
    });
    return toExamViews(rows);
  }

  /**
   * ORD-042. Fewer rows than ids means one determination is not catalogued.
   *
   * ⚠️ RETIRED ONES INCLUDED (revisión clínica de `fix/atencion-examenes`).
   * Retiring an analyte means it is not offered for a new structure; the
   * orders already issued still expect it, and a report that carries it —or a
   * correction of one that did (ORD-055)— must still be receivable. Refusing
   * it rejected the whole report (ORD-042) and left a wrong value
   * uncorrectable.
   */
  async analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.analyteDefinition.findMany({
      where: { id: { in: [...ids] } },
      select: ANALYTE_SELECT,
    });
    return rows.map(toAnalyte);
  }

  /** ORD-149. By frozen name, active first, retired ones included. */
  async analytesByNames(
    names: readonly string[],
  ): Promise<AnalyteDefinition[]> {
    if (names.length === 0) return [];
    const rows = await this.prisma.analyteDefinition.findMany({
      where: { name: { in: [...new Set(names)] } },
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      select: ANALYTE_SELECT,
    });
    return rows.map(toAnalyte);
  }
}

/** Rows to views, dropping any the order cannot carry. */
function toExamViews(rows: readonly ExamRow[]): OrderableExamView[] {
  return rows.flatMap((row) => {
    const view = toExamView(row);
    return view ? [view] : [];
  });
}

/**
 * Row to view, analytes in their stored position. `undefined` for a service
 * without extension or of a kind that is never ordered — which
 * `trg_service_exam_kind_admits` already keeps from existing.
 */
export function toExamView(row: ExamRow): OrderableExamView | undefined {
  const category = orderCategoryOf(row.kind);
  if (!row.exam || !category) return undefined;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category,
    form010Section: row.exam.form010Section,
    specimenType: row.exam.specimenType,
    patientPreparation: row.exam.patientPreparation,
    turnaroundHours: row.exam.turnaroundHours,
    requiresFasting: row.exam.requiresFasting,
    fastingHours: row.exam.fastingHours,
    mspCode: row.mspCode,
    performedExternally: row.exam.performedExternally,
    externalLabName: row.exam.externalLabName,
    analytes: row.exam.analytes.map((entry) => ({
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
export function toRange(row: {
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
