import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';

import {
  SERVICE_ORDER_REPOSITORY,
  type PendingOrderEntry,
  type ServiceOrderRepository,
  type ServiceOrderView,
  type SiteScopeFilter,
} from '../domain/service-order.repository';
import {
  EXAM_CATALOGUE_REPOSITORY,
  type ExamCatalogueRepository,
} from '../domain/exam-catalogue.repository';
import {
  ExamCategoryMismatchError,
  ExamNotOrderableError,
  OrderNotFoundError,
  ResultChartUnmatchedError,
} from '../domain/orders.errors';
import type {
  ServiceOrderCategory,
  ServiceOrderPriority,
} from '../domain/service-order';

/**
 * Who is asking, for the site scope and for the access trail.
 *
 * Declared in the application layer and not taken from HTTP: the controller
 * resolves the principal and hands over the two facts the use case needs — the
 * identity and the scope — so nothing below this line knows what a request is.
 */
export interface Requester {
  userId: string;
  /** ORD-090. The caller's own resolved scope, NEVER a site they named. */
  sites: SiteScopeFilter;
  ip?: string;
  userAgent?: string;
}

/** ORD-001, ORD-095. What composing an order needs to be told. */
export interface PlaceOrderRequest {
  encounterId: string;
  category: ServiceOrderCategory;
  priority: ServiceOrderPriority;
  clinicalNoteText?: string;
  lines: readonly { examDefinitionId: string }[];
}

/** ORD-096. The draft's new content, addressed by the order. */
export type RewriteOrderRequest = Omit<PlaceOrderRequest, 'encounterId'> & {
  orderId: string;
};

/** ORD-020 to ORD-025, ORD-081. What the pending worklist is asked for. */
export interface PendingOrdersRequest {
  category?: ServiceOrderCategory;
  examCode?: string;
  /** ORD-081. The cedula the paper report carries. Resolved to a chart first. */
  cedula?: string;
  limit: number;
}

/**
 * The order: asking for an exam, and knowing what has not come back.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WORKLIST IS THE POINT OF THIS SERVICE, NOT A REPORT ON TOP OF IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Órdenes sin resultado, que envejecen» is the piece almost nobody builds,
 * and its absence is measured: reviews of nineteen studies put the failure to
 * follow up a result between 6,8 % and 62 %, with missed cancers among the
 * consequences. An order from ten days ago with no answer is as dangerous as
 * an orphan result and MUCH more invisible, because nobody is looking for it.
 *
 * ⚠️ AND IT COVERS EVERY CHANNEL (ORD-023). There is no «integrated» mode and
 * no «manual» mode here: there is one worklist, fed by the order, which always
 * exists. A hybrid paper-electronic worklist that shows only the integrated
 * laboratory improves ergonomics and makes patients LESS safe — that is
 * measured too, and the number is 7,1 % of abnormal results never
 * communicated.
 *
 * ⚠️ WHAT THIS SERVICE DOES NOT DO, AND EACH ABSENCE IS A REQUIREMENT:
 *
 *  - IT DOES NOT PRICE ANYTHING (ORD-002). No amount is read, written or
 *    served. One line of the order is one line of the invoice, and what it
 *    costs is a `charge_item` of `billing`, resolved from the price list of
 *    the payer on the service date.
 *  - IT DOES NOT CREATE A PATIENT (ORD-080). `chartByCedula` reads and there
 *    is no counterpart that writes, in this file or anywhere in this module.
 *    Creating a chart from an incoming result is the main cause of duplicate
 *    records in the systems that do it the other way round.
 *  - IT DOES NOT EDIT AN ISSUED ORDER. A draft is rewritten whole until it is
 *    issued (ORD-096); from then on a line asked for by mistake is CANCELLED,
 *    with its row intact (ORD-007): deleting it would erase that somebody
 *    asked for something and changed their mind, which is precisely what has
 *    to stay auditable.
 */
@Injectable()
export class ServiceOrderService {
  constructor(
    @Inject(SERVICE_ORDER_REPOSITORY)
    private readonly orders: ServiceOrderRepository,
    @Inject(EXAM_CATALOGUE_REPOSITORY)
    private readonly exams: ExamCatalogueRepository,
    private readonly logger: PinoLogger,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {
    this.logger.setContext(ServiceOrderService.name);
  }

  /**
   * ORD-001 to ORD-005, ORD-095, ORD-097. Composes one DRAFT order with its
   * lines; it takes no number until it is issued (ORD-098).
   *
   * WHAT IS CHECKED HERE is what no constraint can see: that every orderable
   * named exists, is active and is of the order's category. Everything else —
   * the attention's state, the tariff concept's validity on the clinical date
   * — is arbitrated INSIDE the write, because each is a race and a read taken
   * first can be stale by the time the row lands.
   */
  async compose(
    request: PlaceOrderRequest,
    requester: Requester,
  ): Promise<ServiceOrderView> {
    await this.checkOrderable(request);

    const order = await this.orders.compose({
      encounterId: request.encounterId,
      category: request.category,
      priority: request.priority,
      clinicalNoteText: request.clinicalNoteText,
      lines: request.lines,
      sites: requester.sites,
    });

    /**
     * ORD-024. THE SITE, THE FACT AND THE COUNT — never what was ordered. The
     * name of an exam in a log line is a clinical fact about an identifiable
     * person sitting in a file nobody treats as clinical, and nothing is
     * interpolated: the logger prunes by allowlist and a template string walks
     * straight past it.
     */
    this.logger.info(
      {
        site_id: order.siteId,
        action: 'SERVICE_ORDER_COMPOSED',
        item_count: order.items.length,
      },
      'service order composed',
    );

    return order;
  }

  /** ORD-096, ORD-097. Rewrites a draft whole, with the checks of `compose`. */
  async rewrite(
    request: RewriteOrderRequest,
    requester: Requester,
  ): Promise<ServiceOrderView> {
    await this.checkOrderable(request);

    const order = await this.orders.rewrite({
      orderId: request.orderId,
      category: request.category,
      priority: request.priority,
      clinicalNoteText: request.clinicalNoteText,
      lines: request.lines,
      sites: requester.sites,
    });

    this.logger.info(
      {
        site_id: order.siteId,
        action: 'SERVICE_ORDER_REWRITTEN',
        item_count: order.items.length,
      },
      'service order rewritten',
    );

    return order;
  }

  /** ORD-098. Issues a draft: from here it has its number and is frozen. */
  async issue(
    orderId: string,
    requester: Requester,
  ): Promise<ServiceOrderView> {
    const order = await this.orders.issue({ orderId, sites: requester.sites });

    this.logger.info(
      {
        site_id: order.siteId,
        action: 'SERVICE_ORDER_PLACED',
        item_count: order.items.length,
      },
      'service order placed',
    );

    return order;
  }

  /** ORD-099. Discards a draft; the row stays, with who and when. */
  async discard(
    orderId: string,
    requester: Requester,
  ): Promise<ServiceOrderView> {
    const order = await this.orders.discard({
      orderId,
      sites: requester.sites,
      userId: requester.userId,
    });

    this.logger.info(
      { site_id: order.siteId, action: 'SERVICE_ORDER_DISCARDED' },
      'service order discarded',
    );

    return order;
  }

  /**
   * ORD-003, ORD-097. THE WHOLE ORDER OR NOTHING. Comparing counts rather than
   * looking each one up in turn is deliberate: `activeByIds` returns only
   * what is orderable, so a short answer means at least one line names
   * something retired or invented — and which one it is does not change what
   * the caller does next, which is pick from the list.
   */
  private async checkOrderable(
    request: Pick<PlaceOrderRequest, 'category' | 'lines'>,
  ): Promise<void> {
    const wanted = [...new Set(request.lines.map((line) => line.examDefinitionId))]; // prettier-ignore
    const orderable = await this.exams.activeByIds(wanted);
    if (orderable.length !== wanted.length) throw new ExamNotOrderableError();
    if (orderable.some((exam) => exam.category !== request.category)) {
      throw new ExamCategoryMismatchError();
    }
  }

  /** ORD-009. One order with its lines, within the caller's scope. */
  async byId(orderId: string, requester: Requester): Promise<ServiceOrderView> {
    const order = await this.orders.byId({ orderId, sites: requester.sites });
    if (!order) throw new OrderNotFoundError();
    return order;
  }

  /** ORD-002, ORD-009. The orders of one attention, newest first. */
  ofEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<ServiceOrderView[]> {
    return this.orders.ofEncounter(encounterId, requester.sites);
  }

  /**
   * ORD-020 to ORD-025, ORD-081. The worklist of what has not come back.
   *
   * ⚠️ NOT AUDITED PER ENTRY (ORD-092). A list that refreshes on a screen
   * somebody leaves open would produce thousands of rows a day and turn the
   * trail into noise, which is how the rows that matter get lost. It is the
   * same decision EN-123 took for the listing of attentions, and it is
   * affordable for the same reason: what travels is thin (ORD-024).
   *
   * ⚠️ THE INSTANT IS TAKEN ONCE, HERE. Letting each row read the clock would
   * make two entries of one listing age against two different «now», and the
   * first symptom would be a list whose order changes while nobody touches it.
   */
  async pending(
    request: PendingOrdersRequest,
    requester: Requester,
    now: Date,
  ): Promise<PendingOrderEntry[]> {
    /**
     * ORD-081. The cedula path, and the one place the answer «no» matters: no
     * chart, no worklist, AND NO CHART CREATED. It is refused before the
     * listing rather than folded into it, so that «esa cédula no está en el
     * fichero» reaches the person holding the paper instead of an empty list
     * they would read as «ya llegó todo».
     */
    let chartId: string | undefined;
    if (request.cedula !== undefined) {
      chartId = await this.orders.chartByCedula(request.cedula);
      if (chartId === undefined) throw new ResultChartUnmatchedError();
    }

    /**
     * ORD-026 (revisión clínica de F-07). The cedula path shows a NAME and
     * what is pending for that person: an access to identified health data,
     * so it leaves ONE row per search — not per refresh of the plain worklist,
     * which ORD-092 keeps out of the trail.
     */
    if (chartId !== undefined) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: 'patient',
        resourceId: chartId,
        action: 'READ',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
    }

    return this.orders.pending({
      sites: requester.sites,
      category: request.category,
      examCode: request.examCode,
      chartId,
      /**
       * ORD-026, D-068 C. The name travels ONLY on the cedula path: whoever
       * searches by it holds the person's document already, so the name tells
       * them nothing new — and it is what lets them see that «RN de …» with
       * the mother's cedula is not the mother's own pending blood count.
       */
      includePatientName: chartId !== undefined,
      now,
      limit: request.limit,
    });
  }

  /**
   * ORD-007, ORD-008. Cancels one line asked for by mistake.
   *
   * The row stays. What changes is its status and its `completed_at`, which is
   * what takes it out of the partial index and lowers `pending_items` through
   * `trg_service_order_item_pending`.
   */
  async cancelItem(
    orderId: string,
    itemId: string,
    requester: Requester,
  ): Promise<ServiceOrderView> {
    const order = await this.orders.cancelItem({
      orderId,
      itemId,
      sites: requester.sites,
    });

    this.logger.info(
      { site_id: order.siteId, action: 'SERVICE_ORDER_ITEM_CANCELLED' },
      'service order item cancelled',
    );

    return order;
  }
}
