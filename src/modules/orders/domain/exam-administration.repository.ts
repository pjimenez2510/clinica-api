import type {
  AnalyteDefinition,
  AnalyteValueType,
  ReferenceRange,
} from './analyte';
import type { OrderableExamView } from './exam-catalogue.repository';

/**
 * The exam catalogue, WRITTEN (ORD-104 to ORD-111).
 *
 * A port of its own beside the read-only `ExamCatalogueRepository`: ordering
 * reads the catalogue every consultation, administering it writes it a few
 * times a year, and the two never share a transaction.
 *
 * ADR-013. The exam IS a service: its name, code, kind, MSP code and order
 * extension are written by billing (BI-280, BI-284). What is left here is
 * the structure of results of a service (ORD-105) and the analytes and their
 * ranges (ORD-104, ORD-106).
 */

/** ORD-105. One ordered service as the structure screen reads it. */
export interface AdminExamView extends OrderableExamView {
  active: boolean;
  externalLabCode: string | null;
}

/** ORD-104. One analyte, with the services that yield it. */
export interface AdminAnalyteView extends AnalyteDefinition {
  loincCode: string | null;
  active: boolean;
  /** ORD-105. Correcting the analyte corrects every one of these. */
  usedBy: readonly { id: string; code: string; name: string }[];
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
  /**
   * ORD-105. The service by id WITH its order extension, active or not;
   * `undefined` when there is no service or it has no extension.
   */
  exam(serviceId: string): Promise<AdminExamView | undefined>;
  /**
   * ORD-105. Replaces the service's structure whole, in the order given.
   * Refuses with `ANALYTE_NOT_FOUND`, inside the write, an analyte missing, or
   * retired and not already in the structure (a retired analyte keeps being
   * received), and with `EXAM_DEFINITION_NOT_FOUND` a service without
   * extension.
   */
  setStructure(
    serviceId: string,
    entries: readonly StructureEntry[],
  ): Promise<AdminExamView>;

  /**
   * ORD-110. How many ISSUED lines of the service still wait for their
   * result: their completeness is judged against the current structure
   * (ORD-039). By the frozen code, which is the service's (ORD-002).
   */
  pendingLines(serviceCode: string): Promise<number>;

  /**
   * ORD-110. Whether any result froze this analyte's name: results are tied
   * to their analyte by that name (ORD-031) and corrected by it (ORD-055).
   */
  analyteHasResults(analyteName: string): Promise<boolean>;

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
