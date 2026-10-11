import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { ReferenceRange } from '../domain/analyte';
import type {
  AdminAnalyteView,
  AdminExamView,
  AnalyteWrite,
  ExamAdministrationRepository,
  RangeVersion,
  StructureEntry,
} from '../domain/exam-administration.repository';
import {
  AnalyteNotFoundError,
  ExamDefinitionNotFoundError,
} from '../domain/orders.errors';
import {
  ANALYTE_SELECT,
  EXAM_SELECT,
  ORDERABLE,
  toAnalyte,
  toExamView,
  toRange,
  type ExamRow,
} from './prisma-exam-catalogue.repository';

/**
 * The exam catalogue, written (ORD-104 to ORD-111).
 *
 * ADR-013. The exam is a `service` with a `service_exam`, both written by
 * billing (BI-280, BI-284); this adapter writes the structure
 * (`service_exam_analyte`) and the analytes with their ranges.
 *
 * ⚠️ NO AMOUNT EVER (ORD-002). No column of a price is selected here.
 *
 * The duplicated analyte codes are not checked by a read first: two
 * administrators typing at once would both pass it.
 * `analyte_definition_code_unique` arbitrates, and `orders.constraints.ts`
 * turns the collision into its sentence.
 */

const ADMIN_ANALYTE_SELECT = {
  ...ANALYTE_SELECT,
  loincCode: true,
  active: true,
  exams: {
    orderBy: { exam: { service: { name: 'asc' } } },
    select: {
      exam: {
        select: { service: { select: { id: true, code: true, name: true } } },
      },
    },
  },
} satisfies Prisma.AnalyteDefinitionSelect;

type AdminAnalyteRow = Prisma.AnalyteDefinitionGetPayload<{
  select: typeof ADMIN_ANALYTE_SELECT;
}>;

@Injectable()
export class PrismaExamAdministrationRepository implements ExamAdministrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ORD-105. The service WITH its order extension, active or not. */
  async exam(serviceId: string): Promise<AdminExamView | undefined> {
    const row = await this.prisma.service.findFirst({
      where: { ...ORDERABLE, id: serviceId },
      select: EXAM_SELECT,
    });
    return row ? toAdminExam(row) : undefined;
  }

  /**
   * ORD-105. Replaces the structure whole, in one transaction: the analytes
   * named are read again INSIDE it, so one retired in the meantime refuses
   * the whole structure rather than leaving half of it.
   */
  async setStructure(
    serviceId: string,
    entries: readonly StructureEntry[],
  ): Promise<AdminExamView> {
    const row = await this.prisma.$transaction(async (tx) => {
      // BI-284. Only a service with an order extension has a structure.
      const exam = await tx.serviceExam.findUnique({
        where: { serviceId },
        select: { analytes: { select: { analyteDefinitionId: true } } },
      });
      if (!exam) throw new ExamDefinitionNotFoundError();

      /**
       * A retired analyte already in the structure stays —it keeps being
       * received for the orders that expect it—; one retired is not ADDED.
       */
      const current = new Set(exam.analytes.map((a) => a.analyteDefinitionId));
      const ids = [...new Set(entries.map((entry) => entry.analyteDefinitionId))]; // prettier-ignore
      const found = await tx.analyteDefinition.findMany({
        where: { id: { in: ids } },
        select: { id: true, active: true },
      });
      const usable = found.filter((a) => a.active || current.has(a.id));
      if (usable.length !== ids.length || ids.length !== entries.length) {
        throw new AnalyteNotFoundError();
      }

      await tx.serviceExamAnalyte.deleteMany({ where: { serviceId } });
      await tx.serviceExamAnalyte.createMany({
        data: entries.map((entry, index) => ({
          serviceId,
          analyteDefinitionId: entry.analyteDefinitionId,
          // ORD-011. The printing order is the order given, stored.
          position: index + 1,
          isReflex: entry.isReflex,
        })),
      });
      return tx.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: EXAM_SELECT,
      });
    });
    return toAdminExam(row);
  }

  async pendingLines(serviceCode: string): Promise<number> {
    return this.prisma.serviceOrderItem.count({
      where: {
        testCode: serviceCode,
        completedAt: null,
        serviceOrder: { status: 'ISSUED' },
      },
    });
  }

  async analyteHasResults(analyteName: string): Promise<boolean> {
    const found = await this.prisma.observationResult.findFirst({
      where: { analyteDisplay: analyteName },
      select: { id: true },
    });
    return found !== null;
  }

  async analytes(): Promise<AdminAnalyteView[]> {
    const rows = await this.prisma.analyteDefinition.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: ADMIN_ANALYTE_SELECT,
    });
    return rows.map(toAdminAnalyte);
  }

  async analyte(id: string): Promise<AdminAnalyteView | undefined> {
    const row = await this.prisma.analyteDefinition.findUnique({
      where: { id },
      select: ADMIN_ANALYTE_SELECT,
    });
    return row ? toAdminAnalyte(row) : undefined;
  }

  async createAnalyte(
    code: string,
    analyte: AnalyteWrite,
  ): Promise<AdminAnalyteView> {
    const row = await this.prisma.analyteDefinition.create({
      data: { code, ...analyteData(analyte) },
      select: ADMIN_ANALYTE_SELECT,
    });
    return toAdminAnalyte(row);
  }

  async updateAnalyte(
    id: string,
    analyte: AnalyteWrite,
  ): Promise<AdminAnalyteView> {
    try {
      const row = await this.prisma.analyteDefinition.update({
        where: { id },
        data: analyteData(analyte),
        select: ADMIN_ANALYTE_SELECT,
      });
      return toAdminAnalyte(row);
    } catch (error) {
      throw notFoundAs(error, new AnalyteNotFoundError());
    }
  }

  /**
   * ORD-106, ORD-113. Close what changes, open what is new, keep what is
   * equal — in one transaction, with the analyte row LOCKED: two saves at
   * once would otherwise both read the same rows in force and leave two
   * versions open side by side (ORD-107).
   *
   * ONE INSTANT closes what goes and opens what comes, so the history has
   * neither a gap nor an overlap — and it is never before the analyte's last
   * change (`trg_analyte_reference_range_history_kept`): a row written by an
   * API whose clock ran ahead —the Playwright runs move it— must still close,
   * and the next version still opens after it.
   */
  async setRanges(
    analyteId: string,
    ranges: readonly ReferenceRange[],
    now: Date,
    analyte?: AnalyteWrite,
  ): Promise<AdminAnalyteView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "analyte_definition" WHERE "id" = ${analyteId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new AnalyteNotFoundError();

      // ORD-141. The unit and the ranges written in it, in the same
      // transaction: a refused range leaves the unit as it was.
      if (analyte) {
        await tx.analyteDefinition.update({
          where: { id: analyteId },
          data: analyteData(analyte),
        });
      }

      // ABSOLUTE ranges are not edited here, so they are not replaced either.
      const inForce = await tx.analyteReferenceRange.findMany({
        where: {
          analyteDefinitionId: analyteId,
          rangeKind: { in: ['REFERENCE', 'CRITICAL'] },
          validTo: null,
        },
        select: { id: true, validFrom: true, ...RANGE_FIELDS },
      });

      const [last] = await tx.$queryRaw<{ latest: Date | null }[]>`
        SELECT max(greatest("valid_from", coalesce("valid_to", "valid_from"))) AS latest
          FROM "analyte_reference_range"
         WHERE "analyte_definition_id" = ${analyteId}::uuid`;
      const latest = last?.latest ?? null;
      const at = latest && latest > now ? latest : now;

      const unmatched = [...inForce];
      const added: ReferenceRange[] = [];
      for (const range of ranges) {
        const same = unmatched.findIndex((current) =>
          sameRange(toRange(current), range),
        );
        if (same >= 0) unmatched.splice(same, 1);
        else added.push(range);
      }

      for (const gone of unmatched) {
        await tx.analyteReferenceRange.update({
          where: { id: gone.id },
          data: { validTo: at },
        });
      }
      await tx.analyteReferenceRange.createMany({
        data: added.map((range) => ({
          analyteDefinitionId: analyteId,
          rangeKind: range.rangeKind,
          sex: range.sex,
          ageMinDays: range.ageMinDays,
          ageMaxDays: range.ageMaxDays,
          low: range.low,
          high: range.high,
          text: range.text,
          validFrom: at,
        })),
      });
      return tx.analyteDefinition.findUniqueOrThrow({
        where: { id: analyteId },
        select: ADMIN_ANALYTE_SELECT,
      });
    });
    return toAdminAnalyte(row);
  }

  /** ORD-114. Newest first; the ones in force are the ones without `validTo`. */
  async rangeHistory(analyteId: string): Promise<RangeVersion[]> {
    const rows = await this.prisma.analyteReferenceRange.findMany({
      where: { analyteDefinitionId: analyteId },
      orderBy: [{ validFrom: 'desc' }, { rangeKind: 'asc' }],
      select: { validFrom: true, validTo: true, ...RANGE_FIELDS },
    });
    return rows.map((row) => ({
      ...toRange(row),
      validFrom: row.validFrom,
      validTo: row.validTo,
    }));
  }
}

/** The columns that make a range what it is. */
const RANGE_FIELDS = {
  rangeKind: true,
  sex: true,
  ageMinDays: true,
  ageMaxDays: true,
  low: true,
  high: true,
  text: true,
} as const;

/**
 * Equal in everything that decides a flag or prints on a report. Bounds are
 * compared as the column stores them, `Decimal(14,4)`: a bound typed with
 * more decimals is rounded on the way in, and comparing it raw would close
 * and reopen the same range on every save.
 */
function sameRange(a: ReferenceRange, b: ReferenceRange): boolean {
  const stored = (bound: number | null) =>
    bound === null ? null : Math.round(bound * 10_000);
  return (
    a.rangeKind === b.rangeKind &&
    a.sex === b.sex &&
    a.ageMinDays === b.ageMinDays &&
    a.ageMaxDays === b.ageMaxDays &&
    stored(a.low) === stored(b.low) &&
    stored(a.high) === stored(b.high) &&
    (a.text ?? null) === (b.text ?? null)
  );
}

/** `allowed_values` is `jsonb`: `null` when there is no list. */
function analyteData(analyte: AnalyteWrite) {
  return {
    ...analyte,
    allowedValues:
      analyte.allowedValues === null
        ? Prisma.DbNull
        : [...analyte.allowedValues],
  };
}

/** Prisma's «record to update not found» becomes the domain's 404. */
function notFoundAs(error: unknown, notFound: Error): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
    ? notFound
    : error;
}

/** ORD-105. A row read through `ORDERABLE` always has its extension. */
function toAdminExam(row: ExamRow): AdminExamView {
  const view = toExamView(row);
  if (!view || !row.exam) throw new ExamDefinitionNotFoundError();
  return {
    ...view,
    active: row.active,
    externalLabCode: row.exam.externalLabCode,
  };
}

function toAdminAnalyte(row: AdminAnalyteRow): AdminAnalyteView {
  return {
    ...toAnalyte(row),
    loincCode: row.loincCode,
    active: row.active,
    usedBy: row.exams.map(({ exam }) => ({
      id: exam.service.id,
      code: exam.service.code,
      name: exam.service.name,
    })),
  };
}
