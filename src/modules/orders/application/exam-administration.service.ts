import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import type { ReferenceRange } from '../domain/analyte';
import {
  assertAnalyteFitsItsType,
  assertRangesHold,
} from '../domain/exam-administration';
import {
  EXAM_ADMINISTRATION_REPOSITORY,
  type AdminAnalyteView,
  type AdminExamView,
  type AnalyteWrite,
  type ExamAdministrationRepository,
  type ExamWrite,
  type StructureEntry,
} from '../domain/exam-administration.repository';
import {
  AnalyteHasResultsError,
  AnalyteNotFoundError,
  AnalyteUnitWithRangesError,
  ExamDefinitionNotFoundError,
  ExamHasOpenOrdersError,
  ExamServiceKindMismatchError,
  ExamServiceNotFoundError,
} from '../domain/orders.errors';

/** Who changes the catalogue, for the trail (ORD-111). */
export interface CatalogueEditor {
  userId: string;
  ip?: string;
  userAgent?: string;
}

const EXAM_RESOURCE = 'exam_definition';
const ANALYTE_RESOURCE = 'analyte_definition';

/**
 * THE EXAM CATALOGUE, ADMINISTERED BY THE CLINIC (ORD-103 to ORD-111).
 *
 * A service of its own and not more methods on `ExamCatalogueService`: that
 * one answers ordering, every consultation, with `catalog:read`; this one
 * writes a few times a year with `catalog:manage`. Two reasons to change,
 * two services (ADR-008 §2).
 *
 * ⚠️ EVERY CHANGE LEAVES A ROW IN `access_audit` (ORD-111). A critical band
 * moved decides whether somebody calls a patient tonight (ORD-060), and who
 * moved it has to be answerable. Only identifiers travel: the trail is not a
 * second copy of the catalogue.
 */
@Injectable()
export class ExamAdministrationService {
  constructor(
    @Inject(EXAM_ADMINISTRATION_REPOSITORY)
    private readonly catalogue: ExamAdministrationRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  exams(): Promise<AdminExamView[]> {
    return this.catalogue.exams();
  }

  async exam(id: string): Promise<AdminExamView> {
    const exam = await this.catalogue.exam(id);
    if (!exam) throw new ExamDefinitionNotFoundError();
    return exam;
  }

  /** ORD-103, ORD-108. A new exam, charged with a service of its own class. */
  async createExam(
    code: string,
    exam: ExamWrite,
    editor: CatalogueEditor,
  ): Promise<AdminExamView> {
    await this.assertServiceFits(exam, true);
    const created = await this.catalogue.createExam(code, exam);
    await this.record(EXAM_RESOURCE, created.id, 'CREATE', editor);
    return created;
  }

  /**
   * ORD-103, ORD-108, ORD-109. The exam corrected; its code never changes.
   * The service's class is checked against the exam AS IT WILL BE, so
   * changing the type of an exam already charged as laboratory into imaging
   * is refused as surely as charging it with an imaging service.
   */
  async updateExam(
    id: string,
    patch: Partial<ExamWrite>,
    editor: CatalogueEditor,
  ): Promise<AdminExamView> {
    const current = await this.exam(id);
    const next: ExamWrite = { ...writeOf(current), ...patch };
    const serviceChanged =
      patch.billableServiceId !== undefined &&
      patch.billableServiceId !== current.billableService?.id;
    if (serviceChanged || patch.category !== undefined) {
      await this.assertServiceFits(next, serviceChanged);
    }
    // Only what changed is written: two tabs saving at once (Datos, Cobro) do
    // not undo each other.
    const updated = await this.catalogue.updateExam(id, patch);
    await this.record(EXAM_RESOURCE, id, 'UPDATE', editor);
    return updated;
  }

  /**
   * ORD-105, ORD-110. The exam's analytes, in printing order, replaced whole.
   *
   * ⚠️ NOT WHILE ITS ORDERS WAIT. Whether an issued line is complete is judged
   * against the CURRENT structure (ORD-039): removing an analyte would close
   * lines without its value, adding one would keep them open forever. Only
   * the printing order may change meanwhile, which judges nothing.
   */
  async setStructure(
    id: string,
    entries: readonly StructureEntry[],
    editor: CatalogueEditor,
  ): Promise<AdminExamView> {
    const current = await this.exam(id);
    const shape = (list: readonly StructureEntry[]) =>
      list
        .map((entry) => `${entry.analyteDefinitionId}:${entry.isReflex}`)
        .sort()
        .join('|');
    const before = current.analytes.map((entry) => ({
      analyteDefinitionId: entry.analyte.id,
      isReflex: entry.isReflex,
    }));
    if (
      shape(before) !== shape(entries) &&
      (await this.catalogue.pendingLines(current.code)) > 0
    ) {
      throw new ExamHasOpenOrdersError();
    }
    const updated = await this.catalogue.setStructure(id, entries);
    await this.record(EXAM_RESOURCE, id, 'UPDATE', editor);
    return updated;
  }

  analytes(): Promise<AdminAnalyteView[]> {
    return this.catalogue.analytes();
  }

  /** ORD-104. A new analyte, its unit and answers fitting its type. */
  async createAnalyte(
    code: string,
    analyte: AnalyteWrite,
    editor: CatalogueEditor,
  ): Promise<AdminAnalyteView> {
    assertAnalyteFitsItsType(analyte);
    const created = await this.catalogue.createAnalyte(code, analyte);
    await this.record(ANALYTE_RESOURCE, created.id, 'CREATE', editor);
    return created;
  }

  /**
   * ORD-104. The analyte corrected —and with it every exam that yields it.
   * Its ranges must still hold for the new type: a numeric analyte turned
   * coded would keep bounds nothing can be compared against.
   */
  async updateAnalyte(
    id: string,
    patch: Partial<AnalyteWrite>,
    editor: CatalogueEditor,
  ): Promise<AdminAnalyteView> {
    const current = await this.requireAnalyte(id);
    const next: AnalyteWrite = {
      name: current.name,
      valueType: current.valueType,
      unit: current.unit,
      decimals: current.decimals,
      allowedValues: current.allowedValues,
      loincCode: current.loincCode,
      active: current.active,
      ...patch,
    };
    assertAnalyteFitsItsType(next);

    /**
     * ORD-110. What its results froze is not rewritten under them: the name
     * ties each result to its analyte (ORD-031) and is what a correction
     * compares (ORD-055); the type and the unit are how they were read.
     */
    const renamed = next.name.trim() !== current.name.trim();
    const retyped = next.valueType !== current.valueType;
    const reunited = (next.unit ?? '') !== (current.unit ?? '');
    if (
      (renamed || retyped || reunited) &&
      (await this.catalogue.analyteHasResults(current.name))
    ) {
      throw new AnalyteHasResultsError();
    }
    // ORD-106. Ranges in the old unit would be read against values in the new
    // one: a critical value nobody is told about (ORD-060).
    const bounded = current.ranges.some(
      (range) => range.low !== null || range.high !== null,
    );
    if (reunited && bounded) throw new AnalyteUnitWithRangesError();
    if (retyped) assertRangesHold(next.valueType, current.ranges);
    const updated = await this.catalogue.updateAnalyte(id, next);
    await this.record(ANALYTE_RESOURCE, id, 'UPDATE', editor);
    return updated;
  }

  /** ORD-106, ORD-107, ORD-110. The analyte's ranges, replaced whole. */
  async setRanges(
    id: string,
    ranges: readonly ReferenceRange[],
    editor: CatalogueEditor,
  ): Promise<AdminAnalyteView> {
    const analyte = await this.requireAnalyte(id);
    assertRangesHold(analyte.valueType, ranges);
    const updated = await this.catalogue.setRanges(id, ranges);
    await this.record(ANALYTE_RESOURCE, id, 'UPDATE', editor);
    return updated;
  }

  private async requireAnalyte(id: string): Promise<AdminAnalyteView> {
    const analyte = await this.catalogue.analyte(id);
    if (!analyte) throw new AnalyteNotFoundError();
    return analyte;
  }

  /**
   * ORD-108, ORD-109. The service's class is the exam's type. A service that
   * is newly chosen must also be active; one already linked and since
   * deactivated does not block correcting the exam's name.
   */
  private async assertServiceFits(
    exam: ExamWrite,
    chosenNow: boolean,
  ): Promise<void> {
    if (exam.billableServiceId === null) return;
    const service = await this.catalogue.service(exam.billableServiceId);
    if (!service || (chosenNow && !service.active)) {
      throw new ExamServiceNotFoundError();
    }
    if (service.kind !== exam.category) {
      throw new ExamServiceKindMismatchError();
    }
  }

  private async record(
    resourceType: string,
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    editor: CatalogueEditor,
  ): Promise<void> {
    await this.audit.record({
      userId: editor.userId,
      resourceType,
      resourceId,
      action,
      ip: editor.ip,
      userAgent: editor.userAgent,
    });
  }
}

/** The writable fields of an exam as it is now. */
function writeOf(exam: AdminExamView): ExamWrite {
  return {
    name: exam.name,
    category: exam.category,
    form010Section: exam.form010Section,
    specimenType: exam.specimenType,
    patientPreparation: exam.patientPreparation,
    turnaroundHours: exam.turnaroundHours,
    performedExternally: exam.performedExternally,
    externalLabName: exam.externalLabName,
    externalLabCode: exam.externalLabCode,
    tariffCode: exam.tariffCode,
    billableServiceId: exam.billableService?.id ?? null,
    active: exam.active,
  };
}
