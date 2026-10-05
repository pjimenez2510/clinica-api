import type { AnalyteDefinition } from './analyte';
import type { ServiceOrderCategory } from './service-order';

/**
 * The ORDERABLE catalogue, as ordering reads it.
 *
 * READ-ONLY HERE: the clinic writes the catalogue through
 * `ExamAdministrationRepository` (ORD-103 to ORD-111), with `catalog:manage`.
 * Retired exams are DISABLED, never deleted —historical orders reference
 * them— so `active` is an ordinary, permanent state of this catalogue.
 */

/** ORD-010 to ORD-012. One orderable, with what it yields. */
export interface ExamDefinitionView {
  id: string;
  /** `EX-BH`. The identity of the row, frozen onto every line that asks for it. */
  code: string;
  name: string;
  /** ORD-097, ORD-101. An order only carries exams of its own category. */
  category: ServiceOrderCategory;
  /** ORD-010. The section of form 010A, so a compliant order can be printed. */
  form010Section: string | null;
  specimenType: string | null;
  /** ORD-010. Printed on the order itself: an unstated fast is a second visit. */
  patientPreparation: string | null;
  turnaroundHours: number | null;
  /**
   * ORD-004, ORD-010. The tariff service the exam is invoiced under. `null`
   * means it cannot be ordered yet, and a screen can say so by its name.
   */
  tariffCode: string | null;
  performedExternally: boolean;
  externalLabName: string | null;
  analytes: readonly ExamAnalyteView[];
}

/** ORD-011, ORD-012. One determination the exam yields, in printing order. */
export interface ExamAnalyteView {
  analyte: AnalyteDefinition;
  /** Stored, never derived: a report read alphabetically cannot be scanned. */
  position: number;
  /** ORD-012, ORD-039. Expected to be absent, so its absence is not a gap. */
  isReflex: boolean;
}

/**
 * The read-only port over the exam catalogue. It never exposes an amount
 * (ORD-002).
 */
export interface ExamCatalogueRepository {
  /** ORD-010 to ORD-012. Every active orderable, with its determinations. */
  active(): Promise<ExamDefinitionView[]>;

  /**
   * ORD-003, ORD-039. The orderables named, by id, ACTIVE ONLY.
   *
   * Returning fewer rows than were asked for is how ORD-003 is answered: the
   * caller compares the counts and refuses the WHOLE order, because a request
   * for five exams that stores four is one nobody notices is short.
   */
  activeByIds(ids: readonly string[]): Promise<ExamDefinitionView[]>;

  /**
   * ORD-039, ORD-040. The orderables named by CODE, active or not.
   *
   * ⚠️ RETIRED ONES INCLUDED, and that is the difference from `activeByIds`.
   * A line freezes `test_code` at the moment of ordering, and the result can
   * arrive after the clinic disabled the exam — so resolving the result of an
   * order placed last month must not depend on the catalogue of today. It is
   * the same reason the code is frozen on the line at all.
   */
  byCodes(codes: readonly string[]): Promise<ExamDefinitionView[]>;

  /**
   * ORD-042. The analytes named, by id, retired ones included: an order
   * issued before an analyte was retired still expects it. Fewer rows means
   * one is unknown.
   */
  analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]>;
}

/** Injection token. The application never names the adapter. */
export const EXAM_CATALOGUE_REPOSITORY = Symbol('ExamCatalogueRepository');
