/**
 * AS-104, AS-106, AS-109. What the assistant reads to propose exams, for a
 * module that does not own `orders` nor the catalogue of services.
 *
 * The attention, its note and the names to clear come from
 * `CodingContextReader`; this port is only what is particular to the order:
 * the clinic's orderable catalogue and what the attention already orders.
 *
 * ⚠️ IT READS AND IT NEVER WRITES. A draft is written by `orders` through its
 * own route, with its checks and its `If-Match` (ORD-095, ORD-181); the
 * assistant never composes, rewrites or issues one (P1, AS-108).
 */

/** ORD-097. The order an exam goes on: its service's kind decides it. */
export type OrderableCategory = 'LABORATORY' | 'IMAGING';

/** AS-104. One exam of the clinic's catalogue, as the assistant offers it. */
export interface OrderableExam {
  serviceId: string;
  /** `LAB-BH`: the service's code, frozen on the order line (ORD-002). */
  code: string;
  name: string;
  category: OrderableCategory;
}

export interface OrderingContextReader {
  /**
   * AS-104 (ADR-013, BI-284). Every active service of kind `LAB_EXAM` or
   * `IMAGING` with its order extension, by name.
   */
  orderableExams(): Promise<OrderableExam[]>;

  /**
   * AS-106. The service codes this attention already orders: in any order
   * not discarded, on a line not annulled.
   */
  orderedCodes(encounterId: string): Promise<string[]>;

  /**
   * AS-109. The codes of the live lines of `serviceOrderId` when that order
   * is of THIS attention and not discarded; null otherwise.
   */
  orderCodes(
    encounterId: string,
    serviceOrderId: string,
  ): Promise<string[] | null>;
}

export const ORDERING_CONTEXT_READER = Symbol('ORDERING_CONTEXT_READER');
