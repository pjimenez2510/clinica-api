import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { ReferenceRange } from '../domain/analyte';
import type {
  AdminAnalyteView,
  AdminExamView,
  AnalyteWrite,
  ExamAdministrationRepository,
  ExamServiceView,
  ExamWrite,
  StructureEntry,
} from '../domain/exam-administration.repository';
import {
  AnalyteNotFoundError,
  ExamDefinitionNotFoundError,
} from '../domain/orders.errors';
import {
  ANALYTE_SELECT,
  EXAM_SELECT,
  toAnalyte,
  toExamView,
} from './prisma-exam-catalogue.repository';

/**
 * The exam catalogue, written (ORD-103 to ORD-111).
 *
 * ⚠️ NO AMOUNT EVER (ORD-002). The service an exam is charged with is shown by
 * code, name and class; what it costs lives in the price lists of `billing`,
 * and no column of a price is selected here.
 *
 * The duplicated codes are not checked by a read first: two administrators
 * typing at once would both pass it. `exam_definition_code_unique` and
 * `analyte_definition_code_unique` arbitrate, and `orders.constraints.ts`
 * turns the collision into its sentence.
 */

const SERVICE_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  category: { select: { name: true, kind: true } },
} satisfies Prisma.BillableServiceSelect;

const ADMIN_EXAM_SELECT = {
  ...EXAM_SELECT,
  active: true,
  externalLabCode: true,
  billableService: { select: SERVICE_SELECT },
} satisfies Prisma.ExamDefinitionSelect;

type AdminExamRow = Prisma.ExamDefinitionGetPayload<{
  select: typeof ADMIN_EXAM_SELECT;
}>;

const ADMIN_ANALYTE_SELECT = {
  ...ANALYTE_SELECT,
  loincCode: true,
  active: true,
  exams: {
    orderBy: { examDefinition: { name: 'asc' } },
    select: {
      examDefinition: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.AnalyteDefinitionSelect;

type AdminAnalyteRow = Prisma.AnalyteDefinitionGetPayload<{
  select: typeof ADMIN_ANALYTE_SELECT;
}>;

@Injectable()
export class PrismaExamAdministrationRepository implements ExamAdministrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async exams(): Promise<AdminExamView[]> {
    const rows = await this.prisma.examDefinition.findMany({
      orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
      select: ADMIN_EXAM_SELECT,
    });
    return rows.map(toAdminExam);
  }

  async exam(id: string): Promise<AdminExamView | undefined> {
    const row = await this.prisma.examDefinition.findUnique({
      where: { id },
      select: ADMIN_EXAM_SELECT,
    });
    return row ? toAdminExam(row) : undefined;
  }

  async createExam(code: string, exam: ExamWrite): Promise<AdminExamView> {
    const row = await this.prisma.examDefinition.create({
      data: { code, ...exam },
      select: ADMIN_EXAM_SELECT,
    });
    return toAdminExam(row);
  }

  async updateExam(id: string, exam: ExamWrite): Promise<AdminExamView> {
    try {
      const row = await this.prisma.examDefinition.update({
        where: { id },
        data: exam,
        select: ADMIN_EXAM_SELECT,
      });
      return toAdminExam(row);
    } catch (error) {
      throw notFoundAs(error, new ExamDefinitionNotFoundError());
    }
  }

  /**
   * ORD-105. Replaces the structure whole, in one transaction: the analytes
   * named are read again INSIDE it, so one retired in the meantime refuses
   * the whole structure rather than leaving half of it.
   */
  async setStructure(
    examId: string,
    entries: readonly StructureEntry[],
  ): Promise<AdminExamView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const exam = await tx.examDefinition.findUnique({
        where: { id: examId },
        select: { id: true },
      });
      if (!exam) throw new ExamDefinitionNotFoundError();

      const ids = [...new Set(entries.map((entry) => entry.analyteDefinitionId))]; // prettier-ignore
      const found = await tx.analyteDefinition.count({
        where: { id: { in: ids }, active: true },
      });
      if (found !== ids.length || ids.length !== entries.length) {
        throw new AnalyteNotFoundError();
      }

      await tx.examDefinitionAnalyte.deleteMany({
        where: { examDefinitionId: examId },
      });
      await tx.examDefinitionAnalyte.createMany({
        data: entries.map((entry, index) => ({
          examDefinitionId: examId,
          analyteDefinitionId: entry.analyteDefinitionId,
          // ORD-011. The printing order is the order given, stored.
          position: index + 1,
          isReflex: entry.isReflex,
        })),
      });
      return tx.examDefinition.findUniqueOrThrow({
        where: { id: examId },
        select: ADMIN_EXAM_SELECT,
      });
    });
    return toAdminExam(row);
  }

  async service(id: string): Promise<ExamServiceView | undefined> {
    const row = await this.prisma.billableService.findUnique({
      where: { id },
      select: SERVICE_SELECT,
    });
    return row ? toService(row) : undefined;
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
   * ORD-106, ORD-110. Delete and insert in one transaction. Safe because no
   * result row references a range: each result froze the bounds it applied.
   */
  async setRanges(
    analyteId: string,
    ranges: readonly ReferenceRange[],
  ): Promise<AdminAnalyteView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const analyte = await tx.analyteDefinition.findUnique({
        where: { id: analyteId },
        select: { id: true },
      });
      if (!analyte) throw new AnalyteNotFoundError();

      await tx.analyteReferenceRange.deleteMany({
        where: { analyteDefinitionId: analyteId },
      });
      await tx.analyteReferenceRange.createMany({
        data: ranges.map((range) => ({
          analyteDefinitionId: analyteId,
          rangeKind: range.rangeKind,
          sex: range.sex,
          ageMinDays: range.ageMinDays,
          ageMaxDays: range.ageMaxDays,
          low: range.low,
          high: range.high,
          text: range.text,
        })),
      });
      return tx.analyteDefinition.findUniqueOrThrow({
        where: { id: analyteId },
        select: ADMIN_ANALYTE_SELECT,
      });
    });
    return toAdminAnalyte(row);
  }
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

function toService(row: {
  id: string;
  code: string;
  name: string;
  active: boolean;
  category: { name: string; kind: string };
}): ExamServiceView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    categoryName: row.category.name,
    kind: row.category.kind,
  };
}

function toAdminExam(row: AdminExamRow): AdminExamView {
  return {
    ...toExamView(row),
    active: row.active,
    externalLabCode: row.externalLabCode,
    billableService: row.billableService ? toService(row.billableService) : null, // prettier-ignore
  };
}

function toAdminAnalyte(row: AdminAnalyteRow): AdminAnalyteView {
  return {
    ...toAnalyte(row),
    loincCode: row.loincCode,
    active: row.active,
    usedBy: row.exams.map((entry) => entry.examDefinition),
  };
}
