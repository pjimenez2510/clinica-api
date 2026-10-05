import type {
  AnalyteDefinition,
  AnalyteValueType,
  ReferenceRange,
} from './analyte';
import type { ExamDefinitionView } from './exam-catalogue.repository';
import type { ServiceOrderCategory } from './service-order';

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
  billableService: ExamServiceView | null;
}

/** ORD-104. One analyte, with the exams that yield it. */
export interface AdminAnalyteView extends AnalyteDefinition {
  loincCode: string | null;
  active: boolean;
  /** ORD-105. Correcting the analyte corrects every one of these. */
  usedBy: readonly { id: string; code: string; name: string }[];
}

/** ORD-103. What an exam is written with, all but its immutable code. */
export interface ExamWrite {
  name: string;
  category: ServiceOrderCategory;
  form010Section: string | null;
  specimenType: string | null;
  patientPreparation: string | null;
  turnaroundHours: number | null;
  performedExternally: boolean;
  externalLabName: string | null;
  externalLabCode: string | null;
  tariffCode: string | null;
  billableServiceId: string | null;
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
  /** `EXAM_CODE_DUPLICATE` comes from `exam_definition_code_unique`. */
  createExam(code: string, exam: ExamWrite): Promise<AdminExamView>;
  updateExam(id: string, exam: ExamWrite): Promise<AdminExamView>;
  /**
   * ORD-105. Replaces the exam's structure whole, in the order given. Refuses
   * with `ANALYTE_NOT_FOUND`, inside the write, an analyte missing or retired.
   */
  setStructure(
    examId: string,
    entries: readonly StructureEntry[],
  ): Promise<AdminExamView>;

  /** ORD-108. The service by id, `undefined` when there is none. */
  service(id: string): Promise<ExamServiceView | undefined>;

  analytes(): Promise<AdminAnalyteView[]>;
  analyte(id: string): Promise<AdminAnalyteView | undefined>;
  /** `ANALYTE_CODE_DUPLICATE` comes from `analyte_definition_code_unique`. */
  createAnalyte(code: string, analyte: AnalyteWrite): Promise<AdminAnalyteView>;
  updateAnalyte(id: string, analyte: AnalyteWrite): Promise<AdminAnalyteView>;
  /**
   * ORD-106, ORD-110. Replaces the analyte's ranges whole. No result points
   * at a range row —each froze the range it applied (ORD-037)—, so nothing
   * registered moves.
   */
  setRanges(
    analyteId: string,
    ranges: readonly ReferenceRange[],
  ): Promise<AdminAnalyteView>;
}

/** Injection token. The application never names the adapter. */
export const EXAM_ADMINISTRATION_REPOSITORY = Symbol(
  'ExamAdministrationRepository',
);
