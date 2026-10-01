import type {
  ServiceOrderCategory,
  ServiceOrderItemStatus,
  ServiceOrderPriority,
} from './service-order';
import type { Ageing } from './order-ageing';

/**
 * What the ORDER needs from storage, stated without naming a database.
 *
 * A PORT: the application depends on this and the Prisma adapter implements
 * it. `dependency-cruiser` enforces the direction.
 *
 * ⚠️ IT ASKS ABOUT ATTENTIONS, PATIENTS AND CATALOGUE CONCEPTS AND IMPORTS
 * NONE OF THOSE MODULES. ORD-005 has to refuse an attention that no longer
 * admits content, ORD-004 has to refuse a concept from the wrong catalogue,
 * ORD-081 has to find a chart by its cedula — and no module imports another.
 * This module declares the facts it needs and its own adapter answers them,
 * the route `encounter` took for the chart and the practitioner.
 */

/**
 * The caller's site scope, as `Principal.sitesFor` states it.
 *
 * Declared here so the port does not import authorisation machinery: the
 * DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];

/**
 * One order as this module serves it.
 *
 * ⚠️ NO PATIENT NAME, NO DIAGNOSIS, NO AMOUNT (ORD-002, ORD-024). The chart id
 * travels because the screen has to link to it; what the person HAS never
 * does, and neither does what the line costs — that is `charge_item`, in
 * `billing`.
 *
 * `number` is the legal number of ORD-006 (A.M. 00002393 art. 43): per site,
 * consecutive, without gaps, assigned by the database. The uuid addresses the
 * row; the number is what is printed and dictated over the phone.
 */
export interface ServiceOrderView {
  id: string;
  encounterId: string;
  siteId: string;
  patientId: string;
  orderedById: string;
  /** ORD-006. Assigned by `service_order_number_assigned`, never by the code. */
  number: number;
  category: ServiceOrderCategory;
  priority: ServiceOrderPriority;
  clinicalNoteText: string | null;
  /** Maintained by `trg_service_order_item_pending`, never written by hand. */
  pendingItems: number;
  requestedAt: Date;
  items: readonly ServiceOrderItemView[];
}

/** ORD-002. One orderable asked for: the unit that ages and that is invoiced. */
export interface ServiceOrderItemView {
  id: string;
  /** ORD-002. Frozen at the moment of ordering, like the CIE-10 of a diagnosis. */
  testCode: string;
  testDisplay: string;
  conceptId: string;
  status: ServiceOrderItemStatus;
  /** `null` means pending. It is what the partial index is built on. */
  completedAt: Date | null;
  createdAt: Date;
}

/** ORD-001. What emitting an order needs to be told. */
export interface NewServiceOrder {
  encounterId: string;
  /**
   * ⚠️ NO `orderedById`, AND THE ABSENCE IS THE DECISION (ORD-001). The order
   * is signed by the PROFESSIONAL OF THE ATTENTION, read from `encounter`
   * inside the write, and never by an id the caller supplies. Two reasons, and
   * either is enough: an id in the request is an order somebody can file under
   * a colleague's name, and the treating professional is who the A.M. 00115-2021
   * makes responsible for what is written into that attention.
   */
  category: ServiceOrderCategory;
  priority: ServiceOrderPriority;
  clinicalNoteText?: string;
  lines: readonly NewOrderLine[];
  /** ORD-090. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
}

/**
 * ORD-002, ORD-004. One line of the request: THE EXAM, and nothing else.
 *
 * The tariff service it is invoiced under is a property of the exam
 * (`exam_definition.tariff_code`) resolved in force on the attention's
 * clinical date inside the transaction. A client that could send it could
 * pair a blood count with the price of a glucose.
 */
export interface NewOrderLine {
  examDefinitionId: string;
}

/** ORD-009. One order, by id, within the caller's scope. */
export interface OrderQuery {
  orderId: string;
  sites: SiteScopeFilter;
}

/**
 * ORD-020 to ORD-025. One entry of the worklist of orders with no result.
 *
 * ⚠️ WHAT IT CARRIES IS DELIBERATELY THIN (ORD-024). The list is opened by
 * everybody holding `record:read` over the site, refreshes on a screen people
 * leave open, and leaves NO audit row per entry (ORD-092) — so a diagnosis or
 * a reason for the visit travelling in it would be a disclosure nobody could
 * reconstruct afterwards. What is here is what the work needs: what was asked
 * for, for whom, when, and how long it has been.
 */
export interface PendingOrderEntry {
  orderId: string;
  /** ORD-006. What a paper report quotes back. */
  orderNumber: number;
  itemId: string;
  siteId: string;
  patientId: string;
  encounterId: string;
  orderedById: string;
  category: ServiceOrderCategory;
  priority: ServiceOrderPriority;
  testCode: string;
  testDisplay: string;
  requestedAt: Date;
  ageing: Ageing;
}

/**
 * ORD-020, ORD-025, ORD-081. What the worklist is asked for.
 *
 * `chartId` is the CHART, and the adapter resolves it through `chartScope` so
 * an order placed on a chart that a merge later absorbed still appears
 * (ORD-093). `cedula` is ORD-081's paper-report path, resolved to a chart
 * first — and refused, never created, when no chart holds it.
 */
export interface PendingOrdersQuery {
  sites: SiteScopeFilter;
  category?: ServiceOrderCategory;
  examCode?: string;
  chartId?: string;
  /** ORD-021. Injected so the ageing of a listing is one consistent instant. */
  now: Date;
  limit: number;
}

/** ORD-007. Cancelling one line that was asked for by mistake. */
export interface CancelOrderItem {
  orderId: string;
  itemId: string;
  sites: SiteScopeFilter;
}

/**
 * The port for orders and their lines. Every read and write takes the caller's
 * site scope (ORD-090).
 */
export interface ServiceOrderRepository {
  /**
   * ORD-001 to ORD-006. Writes one order and its lines.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY CHECK LIVES INSIDE THIS METHOD'S TRANSACTION
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The attention's state, the orderable still being active and the tariff
   * concept still being in force are three questions whose answer can change
   * between a read and a write: a catalogue release lands, the attention gets
   * closed by whoever is settling the account. Exposing any of them as a
   * question a caller can ask first and act on later is the race AG-045 was
   * left open by.
   *
   * ⚠️ ALL LINES OR NONE (ORD-003). A request for five exams that stores four
   * is a request in which nobody notices which one is missing.
   */
  place(order: NewServiceOrder): Promise<ServiceOrderView>;

  /** ORD-009. One order with its lines, within the caller's scope. */
  byId(query: OrderQuery): Promise<ServiceOrderView | undefined>;

  /** ORD-002, ORD-009. The orders of one attention, newest first. */
  ofEncounter(
    encounterId: string,
    sites: SiteScopeFilter,
  ): Promise<ServiceOrderView[]>;

  /**
   * ORD-020 to ORD-025. The worklist of what was asked for and has not come
   * back, oldest first.
   *
   * ⚠️ IT COVERS EVERY CHANNEL (ORD-023), and that is the requirement this
   * whole module exists for: it is built on the ORDER, which always exists,
   * and never on how the result comes back. A hybrid paper-electronic worklist
   * that only shows the integrated laboratory improves ergonomics and makes
   * patients less safe — it is measured, and the number is 7,1 % of abnormal
   * results never communicated.
   */
  pending(query: PendingOrdersQuery): Promise<PendingOrderEntry[]>;

  /**
   * ORD-007, ORD-008. Cancels one line.
   *
   * SETS `completed_at` AS WELL AS THE STATUS, and both are needed: the status
   * is what a human reads, and `completed_at` is what takes the row out of the
   * partial index `service_order_item_pending` and makes
   * `trg_service_order_item_pending` lower `pending_items`. Setting only one of
   * the two leaves the worklist and the record disagreeing.
   */
  cancelItem(request: CancelOrderItem): Promise<ServiceOrderView>;

  /**
   * ORD-081. The live chart that holds this cedula, or `undefined`.
   *
   * ⚠️ IT ONLY READS. There is no counterpart that creates a chart, in this
   * port or anywhere in this module, and the absence IS ORD-080.
   */
  chartByCedula(cedula: string): Promise<string | undefined>;
}

/** Injection token. The application never names the adapter. */
export const SERVICE_ORDER_REPOSITORY = Symbol('ServiceOrderRepository');
