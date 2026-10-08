import type {
  AnalyteDefinition,
  AnalyteValueType,
  ReferenceRange,
} from './analyte';
import type { ExamDefinitionView } from './exam-catalogue.repository';
import type { ServiceOrderCategory } from './service-order';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * The exam catalogue, WRITTEN (ORD-103 to ORD-111).
 *
 * A port of its own beside the read-only `ExamCatalogueRepository`: ordering
 * reads the catalogue every consultation, administering it writes it a few
 * times a year, and the two never share a transaction.
 *
 * ⚠️ IT READS `billable_service` AND IMPORTS NOTHING FROM `billing`. ORD-108
 * compares the exam's type with the class of the service it is charged with;
 * this module declares that fact (`ServiceKindView`) and its own adapter
 * answers it — no module imports another.
 */

/** ORD-108. The service an exam is charged with, as the catalogue shows it. */
export interface ExamServiceView {
  id: string;
  code: string;
  name: string;
  categoryName: string;
  /** `billable_service_category.kind`: CONSULTATION … OTHER. */
  kind: string;
  active: boolean;
}

/** ORD-103. One exam as the administration screen reads it. */
export interface AdminExamView extends ExamDefinitionView {
  active: boolean;
  externalLabCode: string | null;
  /** ORD-163. Always one: the exam IS its service. */
  billableService: ExamServiceView;
}

/** ORD-104. One analyte, with the exams that yield it. */
export interface AdminAnalyteView extends AnalyteDefinition {
  loincCode: string | null;
  active: boolean;
  /** ORD-105. Correcting the analyte corrects every one of these. */
  usedBy: readonly { id: string; code: string; name: string }[];
}

/**
 * ORD-103. What an exam is written with, all but its immutable code.
 * `name` and `tariffCode` are written ON ITS SERVICE (ORD-163).
 */
export interface ExamWrite {
  name: string;
  category: ServiceOrderCategory;
  form010Section: string | null;
  specimenType: string | null;
  patientPreparation: string | null;
  turnaroundHours: number | null;
  /** ORD-129. «Pide ayuno» and its minimum hours. */
  requiresFasting: boolean;
  fastingHours: number | null;
  performedExternally: boolean;
  externalLabName: string | null;
  externalLabCode: string | null;
  tariffCode: string | null;
  active: boolean;
}

/**
 * ORD-162. How a new exam is charged: a service born with it, or one that
 * already exists and charges no other exam.
 */
export type ExamBilling =
  | {
      kind: 'NEW';
      categoryId: string;
      taxRateId: string;
      /** Self-pay price from today (decimal text), or none. */
      selfPayAmount: string | null;
    }
  | { kind: 'EXISTING'; billableServiceId: string };

/** ORD-162. A category of the clinic's catalogue, as the check needs it. */
export interface ServiceCategoryView {
  kind: string;
  active: boolean;
}

/** ORD-104. What an analyte is written with, all but its immutable code. */
export interface AnalyteWrite {
  name: string;
  valueType: AnalyteValueType;
  unit: string | null;
  decimals: number | null;
  allowedValues: readonly string[] | null;
  loincCode: string | null;
  active: boolean;
}

/** ORD-105. One analyte of an exam's structure, in its printing position. */
export interface StructureEntry {
  analyteDefinitionId: string;
  isReflex: boolean;
}

export interface ExamAdministrationRepository {
  /** ORD-103. Every exam, active or not, with structure, ranges and service. */
  exams(): Promise<AdminExamView[]>;
  exam(id: string): Promise<AdminExamView | undefined>;
  /**
   * ORD-162, ORD-163. The exam and, for a NEW billing, its service and first
   * self-pay price from `today` — one transaction. With an EXISTING service
   * the exam takes the service's name and tariff code; the service is not
   * rewritten. `EXAM_CODE_DUPLICATE` comes from
   * `exam_definition_code_unique`, `BILLABLE_SERVICE_CODE_DUPLICATE` from
   * `billable_service_code_unique`, `EXAM_SERVICE_TAKEN` from
   * `exam_definition_one_per_service`.
   */
  createExam(
    code: string,
    exam: ExamWrite,
    billing: ExamBilling,
    today: ClinicalDate,
  ): Promise<AdminExamView>;
  /**
   * Writes only what changed: two tabs saving at once do not undo each other.
   * `name` and `tariffCode` go to the exam's service, in the same transaction.
   */
  updateExam(
    id: string,
    patch: Partial<ExamWrite> & { code?: string },
  ): Promise<AdminExamView>;
  /**
   * ORD-105. Replaces the exam's structure whole, in the order given. Refuses
   * with `ANALYTE_NOT_FOUND`, inside the write, an analyte missing, or retired
   * and not already in the structure (a retired analyte keeps being received).
   */
  setStructure(
    examId: string,
    entries: readonly StructureEntry[],
  ): Promise<AdminExamView>;

  /**
   * ORD-110. How many ISSUED lines of the exam still wait for their result:
   * their completeness is judged against the current structure (ORD-039).
   */
  pendingLines(examCode: string): Promise<number>;

  /**
   * ORD-110. Whether any result froze this analyte's name: results are tied
   * to their analyte by that name (ORD-031) and corrected by it (ORD-055).
   */
  analyteHasResults(analyteName: string): Promise<boolean>;

  /** ORD-140. Whether any order line froze this exam code (ORD-002). */
  examWasOrdered(examCode: string): Promise<boolean>;

  /** ORD-108. The service by id, `undefined` when there is none. */
  service(id: string): Promise<ExamServiceView | undefined>;

  /** ORD-162. Whether an exam is already charged with this service. */
  serviceIsTaken(serviceId: string): Promise<boolean>;

  /** ORD-162. The category by id, `undefined` when there is none. */
  serviceCategory(id: string): Promise<ServiceCategoryView | undefined>;

  /** ORD-162. Whether the tax rate exists. */
  taxRateExists(id: string): Promise<boolean>;

  analytes(): Promise<AdminAnalyteView[]>;
  analyte(id: string): Promise<AdminAnalyteView | undefined>;
  /** `ANALYTE_CODE_DUPLICATE` comes from `analyte_definition_code_unique`. */
  createAnalyte(code: string, analyte: AnalyteWrite): Promise<AdminAnalyteView>;
  updateAnalyte(id: string, analyte: AnalyteWrite): Promise<AdminAnalyteView>;
  /**
   * ORD-106, ORD-113. Replaces the analyte's REFERENCE and CRITICAL ranges
   * whole —ABSOLUTE ones, which this screen does not edit, stay— WITHOUT
   * DELETING ANY ROW: the ones in force that change or go are closed at
   * `now`, the new ones open at `now`, and the ones that stay equal stay
   * open, so the history only records what changed.
   */
  setRanges(
    analyteId: string,
    ranges: readonly ReferenceRange[],
    now: Date,
    /** ORD-141. The analyte's fields, written in the same transaction. */
    analyte?: AnalyteWrite,
  ): Promise<AdminAnalyteView>;

  /** ORD-114. Every range the analyte ever had, open and closed. */
  rangeHistory(analyteId: string): Promise<RangeVersion[]>;
}

/** ORD-113. One row of a range's history, with the time it applied. */
export interface RangeVersion extends ReferenceRange {
  validFrom: Date;
  /** `null` while it is the one in force. */
  validTo: Date | null;
}

/** Injection token. The application never names the adapter. */
export const EXAM_ADMINISTRATION_REPOSITORY = Symbol(
  'ExamAdministrationRepository',
);
