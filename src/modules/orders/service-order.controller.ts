import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { ServiceOrderService } from './application/service-order.service';
import type { Requester } from './application/service-order.service';
import type { PendingOrderEntry } from './domain/service-order.repository';
import type { ServiceOrderView } from './domain/service-order.repository';
import {
  PendingOrderListDto,
  PendingOrdersQueryDto,
  ServiceOrderDto,
  type PendingOrderListResponse,
  type ServiceOrderResponse,
} from './dto/service-order.dto';

/**
 * The order, addressed by its own identifier — and the worklist that is the
 * reason this module exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY `record:read` AND `record:write`, AND NOT A PERMISSION OF THEIR OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ordering an exam IS writing in the history: it is a clinical decision, taken
 * by whoever may diagnose, and art. 198 of the Ley Orgánica de Salud puts that
 * with the professional whose title covers it. Reading the worklist is reading
 * what the chart is waiting for. Inventing `order:read` and `order:write`
 * would have added two boxes to the roles screen that mean exactly what two
 * existing ones already mean — and a permission nobody can distinguish from
 * another is a permission that gets ticked by accident.
 *
 * ⚠️ THE ONE PLACE THAT DOES GET ITS OWN PERMISSION IS TRANSCRIBING A RESULT
 * (`result:write`, ORD-094), and the reason is the opposite one: whoever types
 * a laboratory report may be a technician or an admissions clerk, and
 * `record:write` is what lets somebody DIAGNOSE. See
 * `diagnostic-report.controller.ts`.
 *
 * ⚠️ EVERY ROUTE DECLARES `'query'` SITE SCOPE. The site of an order is the
 * site of its attention, it is not in the URL, and the guard cannot check what
 * it cannot see. The HANDLER narrows with the caller's own resolved scope
 * (ORD-090), and an order outside it answers exactly what a non-existent one
 * answers (ORD-009).
 */
@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class ServiceOrderController {
  constructor(
    private readonly orders: ServiceOrderService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * ORD-020 to ORD-025, ORD-081. What was asked for and has not come back.
   *
   * ⚠️ DECLARED BEFORE `:orderId` ON PURPOSE. Express matches in registration
   * order, and a literal segment after a parameter of the same depth is a
   * route that never runs.
   *
   * ⚠️ NOT AUDITED PER ENTRY (ORD-092): a list that refreshes on a screen
   * somebody leaves open would bury the audit rows that matter. What travels
   * is thin enough to afford it (ORD-024).
   */
  @Get('pending')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary:
      'Listar las órdenes cuyo resultado no ha vuelto, más antiguas primero',
  })
  @ApiOkResponse({ type: PendingOrderListDto })
  async pending(
    @Query() query: PendingOrdersQueryDto,
    @Req() req: Request,
  ): Promise<PendingOrderListResponse> {
    const items = await this.orders.pending(
      {
        category: query.category,
        examCode: query.examCode,
        cedula: query.cedula,
        limit: query.limit,
      },
      this.requester(req, 'record:read'),
      // ORD-021. ONE instant for the whole listing: two entries aged against
      // two different «now» is a list whose order changes untouched.
      new Date(),
    );
    return { items: items.map(toPendingResponse) };
  }

  /** ORD-009. One order with its lines. */
  @Get(':orderId')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Ver una orden y sus líneas' })
  @ApiOkResponse({ type: ServiceOrderDto })
  async byId(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() req: Request,
  ): Promise<ServiceOrderResponse> {
    const order = await this.orders.byId(
      orderId,
      this.requester(req, 'record:read'),
    );
    return toOrderResponse(order);
  }

  /**
   * ORD-007, ORD-008. Anula una línea pedida por error.
   *
   * A `POST` AND NOT A `DELETE`, and the verb is the requirement: the row
   * stays. What changes is its status and its `completed_at`, which is what
   * takes it out of the worklist. Deleting it would erase that somebody asked
   * for something and changed their mind — precisely what has to stay
   * auditable.
   */
  @Post(':orderId/items/:itemId/cancel')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una línea de la orden pedida por error' })
  @ApiOkResponse({ type: ServiceOrderDto })
  async cancelItem(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Req() req: Request,
  ): Promise<ServiceOrderResponse> {
    const order = await this.orders.cancelItem(
      orderId,
      itemId,
      this.requester(req, 'record:write'),
    );
    return toOrderResponse(order);
  }

  /** Who is asking, for the site scope and for the access trail. */
  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
export function toOrderResponse(order: ServiceOrderView): ServiceOrderResponse {
  return {
    id: order.id,
    encounterId: order.encounterId,
    siteId: order.siteId,
    patientId: order.patientId,
    orderedById: order.orderedById,
    number: order.number,
    category: order.category,
    priority: order.priority,
    clinicalNoteText: order.clinicalNoteText,
    pendingItems: order.pendingItems,
    requestedAt: order.requestedAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      testCode: item.testCode,
      testDisplay: item.testDisplay,
      conceptId: item.conceptId,
      status: item.status,
      completedAt: item.completedAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

/** ORD-024. The worklist entry, flattened. No clinical content travels. */
function toPendingResponse(
  entry: PendingOrderEntry,
): PendingOrderListResponse['items'][number] {
  return {
    orderId: entry.orderId,
    orderNumber: entry.orderNumber,
    itemId: entry.itemId,
    siteId: entry.siteId,
    patientId: entry.patientId,
    encounterId: entry.encounterId,
    orderedById: entry.orderedById,
    category: entry.category,
    priority: entry.priority,
    testCode: entry.testCode,
    testDisplay: entry.testDisplay,
    requestedAt: entry.requestedAt.toISOString(),
    waitingDays: entry.ageing.waitingDays,
    overdue: entry.ageing.overdue,
    dueAt: entry.ageing.dueAt?.toISOString() ?? null,
  };
}
