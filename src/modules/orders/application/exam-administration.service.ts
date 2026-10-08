import { Inject, Injectable } from '@nestjs/common';

import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import { type ReferenceRange, boundsCarriedOver } from '../domain/analyte';
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
  type ExamBilling,
  type ExamWrite,
  type RangeVersion,
  type StructureEntry,
} from '../domain/exam-administration.repository';
import {
  AnalyteHasResultsError,
  AnalyteNotFoundError,
  AnalyteUnitWithRangesError,
  ExamDefinitionNotFoundError,
  ExamCodeInUseError,
  ExamHasOpenOrdersError,
  ExamServiceCategoryNotFoundError,
  ExamServiceKindMismatchError,
  ExamServiceNotFoundError,
  ExamServiceTakenError,
  ExamTaxRateNotFoundError,
} from '../domain/orders.errors';
import type { ServiceOrderCategory } from '../domain/service-order';

/** Who changes the catalogue, for the trail (ORD-111). */
export interface CatalogueEditor {
  userId: string;
  ip?: string;
  userAgent?: string;
}

const EXAM_RESOURCE = 'exam_definition';
const ANALYTE_RESOURCE = 'analyte_definition';
/** BI-231. The billing trail's name for a service. */
const SERVICE_RESOURCE = 'billable_service';

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
 * moved it has to be answerable. Since ORD-142 an edit also carries what it
 * replaced and what it left — the editable fields, never the `usedBy` lists
 * or the service's row — because «who moved the band» is half an answer
 * without «from where to where» (D-150).
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

  /**
   * ORD-103, ORD-108, ORD-162. A new exam, born with its service —or tied to
   * one of its class that charges no other exam—, in one transaction. Who may
   * set a price is the controller's question (`billing:price-manage`).
   */
  async createExam(
    code: string,
    exam: ExamWrite,
    billing: ExamBilling,
    editor: CatalogueEditor,
    now: Date = new Date(),
  ): Promise<AdminExamView> {
    await this.assertBillingFits(exam.category, billing);
    const created = await this.catalogue.createExam(
      code,
      exam,
      billing,
      clinicalDateOf(now),
    );
    await this.record(EXAM_RESOURCE, created.id, 'CREATE', editor, {
      after: examSnapshot(created),
    });
    // BI-231 (D-179). The service born with the exam is billing's row, and
    // who classified it —category, tax rate, first price— must be readable
    // in billing's own trail.
    if (billing.kind === 'NEW') {
      await this.record(
        SERVICE_RESOURCE,
        created.billableService.id,
        'CREATE',
        editor,
        {
          after: {
            code: created.billableService.code,
            name: created.billableService.name,
            categoryId: billing.categoryId,
            taxRateId: billing.taxRateId,
            tariffCode: created.tariffCode,
            selfPayAmount: billing.selfPayAmount,
          },
        },
      );
    }
    return created;
  }

  /**
   * ORD-103, ORD-108, ORD-109. The exam corrected; its code never changes.
   * The service's class is checked against the exam AS IT WILL BE, so
   * changing the type of an exam already charged as laboratory into imaging
   * is refused as surely as charging it with an imaging service.
   */
  /** ORD-140. Whether an order line already froze this exam code. */
  async isExamCodeLocked(examCode: string): Promise<boolean> {
    return this.catalogue.examWasOrdered(examCode);
  }

  async updateExam(
    id: string,
    patch: Partial<ExamWrite> & { code?: string },
    editor: CatalogueEditor,
  ): Promise<AdminExamView> {
    const current = await this.exam(id);
    // ORD-140. The code is a typo to fix until an order line froze it.
    if (
      patch.code !== undefined &&
      patch.code !== current.code &&
      (await this.catalogue.examWasOrdered(current.code))
    ) {
      throw new ExamCodeInUseError();
    }
    // ORD-109. The service stays (ORD-163); the type must still be its class.
    if (
      patch.category !== undefined &&
      patch.category !== current.billableService.kind
    ) {
      throw new ExamServiceKindMismatchError();
    }
    // Only what changed is written: two tabs saving at once (Datos, Cobro) do
    // not undo each other.
    const updated = await this.catalogue.updateExam(id, patch);
    await this.record(EXAM_RESOURCE, id, 'UPDATE', editor, {
      before: examSnapshot(current),
      after: examSnapshot(updated),
    });
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
    await this.record(EXAM_RESOURCE, id, 'UPDATE', editor, {
      before: structureSnapshot(current),
      after: structureSnapshot(updated),
    });
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
    await this.record(ANALYTE_RESOURCE, created.id, 'CREATE', editor, {
      after: analyteSnapshot(created),
    });
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
    /** ORD-141. The ranges written in the new unit, saved with it. */
    ranges?: readonly ReferenceRange[],
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
    // ORD-141. With the new ranges in the same save, the unit and its ranges
    // change together in one transaction, or neither does.
    if (ranges !== undefined) {
      // ORD-141. Ranges sent with a new unit must be written IN it.
      if (reunited && boundsCarriedOver(current.ranges, ranges)) {
        throw new AnalyteUnitWithRangesError();
      }
      assertRangesHold(next.valueType, ranges);
      const updated = await this.catalogue.setRanges(
        id,
        ranges,
        new Date(),
        next,
      );
      await this.record(ANALYTE_RESOURCE, id, 'UPDATE', editor, {
        before: { ...analyteSnapshot(current), ...rangesSnapshot(current) },
        after: { ...analyteSnapshot(updated), ...rangesSnapshot(updated) },
      });
      return updated;
    }
    if (reunited && bounded) throw new AnalyteUnitWithRangesError();
    if (retyped) assertRangesHold(next.valueType, current.ranges);
    const updated = await this.catalogue.updateAnalyte(id, next);
    await this.record(ANALYTE_RESOURCE, id, 'UPDATE', editor, {
      before: analyteSnapshot(current),
      after: analyteSnapshot(updated),
    });
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
    // ORD-113. ONE instant for what closes and what opens, from the
    // application's clock: the history then reads without a gap or an overlap.
    const updated = await this.catalogue.setRanges(id, ranges, new Date());
    await this.record(ANALYTE_RESOURCE, id, 'UPDATE', editor, {
      before: rangesSnapshot(analyte),
      after: rangesSnapshot(updated),
    });
    return updated;
  }

  /** ORD-114. What applied when: every version, open and closed. */
  async rangeHistory(id: string): Promise<RangeVersion[]> {
    await this.requireAnalyte(id);
    return this.catalogue.rangeHistory(id);
  }

  private async requireAnalyte(id: string): Promise<AdminAnalyteView> {
    const analyte = await this.catalogue.analyte(id);
    if (!analyte) throw new AnalyteNotFoundError();
    return analyte;
  }

  /**
   * ORD-108, ORD-162. The service's class is the exam's type. A NEW service's
   * category must be active and the rate must exist; an EXISTING one must be
   * active, of the exam's class and charge no other exam (ORD-163).
   */
  private async assertBillingFits(
    category: ServiceOrderCategory,
    billing: ExamBilling,
  ): Promise<void> {
    if (billing.kind === 'NEW') {
      const serviceCategory = await this.catalogue.serviceCategory(
        billing.categoryId,
      );
      if (!serviceCategory?.active)
        throw new ExamServiceCategoryNotFoundError();
      if (serviceCategory.kind !== category) {
        throw new ExamServiceKindMismatchError();
      }
      if (!(await this.catalogue.taxRateExists(billing.taxRateId))) {
        throw new ExamTaxRateNotFoundError();
      }
      return;
    }
    const service = await this.catalogue.service(billing.billableServiceId);
    if (!service?.active) throw new ExamServiceNotFoundError();
    if (service.kind !== category) throw new ExamServiceKindMismatchError();
    if (await this.catalogue.serviceIsTaken(service.id)) {
      throw new ExamServiceTakenError();
    }
  }

  private async record(
    resourceType: string,
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    editor: CatalogueEditor,
    change: { before?: Readonly<object>; after?: Readonly<object> } = {},
  ): Promise<void> {
    await this.audit.record({
      userId: editor.userId,
      resourceType,
      resourceId,
      action,
      ip: editor.ip,
      userAgent: editor.userAgent,
      // ORD-142. Plain copies; `exam_definition` and `analyte_definition`
      // carry a payload since `admin_edit_in_place` (D-150). A catalogue row,
      // never a patient's result.
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
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
    requiresFasting: exam.requiresFasting,
    fastingHours: exam.fastingHours,
    performedExternally: exam.performedExternally,
    externalLabName: exam.externalLabName,
    externalLabCode: exam.externalLabCode,
    tariffCode: exam.tariffCode,
    active: exam.active,
  };
}

/** ORD-142. An exam's editable fields, with the immutable code that names it. */
function examSnapshot(exam: AdminExamView): object {
  return {
    code: exam.code,
    ...writeOf(exam),
    billableServiceId: exam.billableService.id,
  };
}

/** ORD-142. The exam's analytes in printing order, as `setStructure` takes them. */
function structureSnapshot(exam: AdminExamView): object {
  return {
    analytes: exam.analytes.map((entry) => ({
      analyteDefinitionId: entry.analyte.id,
      isReflex: entry.isReflex,
    })),
  };
}

/**
 * ORD-142. An analyte's editable fields. Not its ranges, which `setRanges`
 * replaces and audits on its own, and not `usedBy`, which nobody edits here.
 */
function analyteSnapshot(analyte: AdminAnalyteView): object {
  return {
    code: analyte.code,
    name: analyte.name,
    valueType: analyte.valueType,
    unit: analyte.unit,
    decimals: analyte.decimals,
    allowedValues: analyte.allowedValues && [...analyte.allowedValues],
    loincCode: analyte.loincCode,
    active: analyte.active,
  };
}

/** ORD-142. The analyte's reference ranges, replaced whole (ORD-106). */
function rangesSnapshot(analyte: AdminAnalyteView): object {
  return { ranges: analyte.ranges.map((range) => ({ ...range })) };
}
