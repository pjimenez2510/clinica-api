import type { AnalyteDefinition } from './analyte';
import type { ServiceOrderCategory } from './service-order';

/**
 * The ORDERABLE catalogue, as ordering reads it.
 *
 * ADR-013, BI-284. An orderable IS a service of the clinic's one catalogue
 * —LAB_EXAM, IMAGING or PROCEDURE— that carries an order extension
 * (`service_exam`). Billing writes the service and its extension (BI-280);
 * this module writes only its structure of results (ORD-105). Retired
 * services are DISABLED, never deleted —historical orders reference them—
 * so `active` is an ordinary, permanent state of this catalogue.
 */

/**
 * BI-284. The order category a service kind is ordered under. `undefined`
 * for a kind that is never ordered (a consultation, a supply).
 */
export function orderCategoryOf(
  kind: string,
): ServiceOrderCategory | undefined {
  switch (kind) {
    case 'LAB_EXAM':
      return 'LABORATORY';
    case 'IMAGING':
      return 'IMAGING';
    case 'PROCEDURE':
      return 'PROCEDURE';
    default:
      return undefined;
  }
}

/** ORD-010 to ORD-012. One orderable service, with what it yields. */
export interface OrderableExamView {
  /** ORD-010 (BI-284). The SERVICE's id: there is no exam row of its own. */
  id: string;
  /** `LAB-BH`. The service's code, frozen onto every line that asks for it. */
  code: string;
  name: string;
  /** ORD-097, ORD-101. Derived from the service's kind (`orderCategoryOf`). */
  category: ServiceOrderCategory;
  /** ORD-010. The section of form 010A, so a compliant order can be printed. */
  form010Section: string | null;
  specimenType: string | null;
  /** ORD-010. Printed on the order itself: an unstated fast is a second visit. */
  patientPreparation: string | null;
  turnaroundHours: number | null;
  /** ORD-129. «Pide ayuno» and its minimum hours. */
  requiresFasting: boolean;
  fastingHours: number | null;
  /**
   * ORD-004, BI-285. The service's MSP code, when it has one. Never a
   * condition to order (D-218 §1): with one in force on the clinical date the
   * line keeps its TARIFF concept, without one it keeps none.
   */
  mspCode: string | null;
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
  active(): Promise<OrderableExamView[]>;

  /**
   * ORD-003, ORD-039. The orderables named, by id, ACTIVE ONLY.
   *
   * Returning fewer rows than were asked for is how ORD-003 is answered: the
   * caller compares the counts and refuses the WHOLE order, because a request
   * for five exams that stores four is one nobody notices is short.
   */
  activeByIds(ids: readonly string[]): Promise<OrderableExamView[]>;

  /**
   * ORD-039, ORD-040. The orderables named by CODE, active or not.
   *
   * ⚠️ RETIRED ONES INCLUDED, and that is the difference from `activeByIds`.
   * A line freezes `test_code` at the moment of ordering, and the result can
   * arrive after the clinic disabled the exam — so resolving the result of an
   * order placed last month must not depend on the catalogue of today. It is
   * the same reason the code is frozen on the line at all.
   */
  byCodes(codes: readonly string[]): Promise<OrderableExamView[]>;

  /**
   * ORD-042. The analytes named, by id, retired ones included: an order
   * issued before an analyte was retired still expects it. Fewer rows means
   * one is unknown.
   */
  analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]>;

  /**
   * ORD-149. Every analyte carrying one of these names —the name a stored
   * result froze—, retired ones included, active first and then the last
   * changed: a report that carries one must stay correctable, and the caller
   * picks the homonym with the result's unit.
   */
  analytesByNames(names: readonly string[]): Promise<AnalyteDefinition[]>;
}

/** Injection token. The application never names the adapter. */
export const EXAM_CATALOGUE_REPOSITORY = Symbol('ExamCatalogueRepository');
