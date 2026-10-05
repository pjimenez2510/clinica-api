import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { ServiceOrderService } from './application/service-order.service';
import { toOrderResponse } from './service-order.controller';
import type { Requester } from './application/service-order.service';
import {
  PlaceOrderDto,
  ServiceOrderDto,
  ServiceOrderListDto,
  type ServiceOrderListResponse,
  type ServiceOrderResponse,
} from './dto/service-order.dto';

/**
 * The orders of one attention: emitting them, and reading what was asked for.
 *
 * A CONTROLLER OF ITS OWN and not more routes on `ServiceOrderController`,
 * because NestJS joins the controller's path to the handler's and these hang
 * off the attention rather than off the order. Keeping the permission of each
 * route readable in one screen is what makes «cerrado por defecto» checkable
 * at a glance.
 *
 * ⚠️ THE ORDER IS SIGNED BY THE PROFESSIONAL OF THE ATTENTION (ORD-001), read
 * from the attention inside the write. There is no `orderedById` field in the
 * body, and the absence is the requirement: an id in a request is an order
 * somebody can file under a colleague's name.
 */
@ApiTags('orders')
@Controller({ path: 'encounters/:encounterId/orders', version: '1' })
export class EncounterOrderController {
  constructor(
    private readonly orders: ServiceOrderService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * ORD-001 to ORD-005, ORD-095. Composes one order with its lines, as a
   * DRAFT: it is issued with `POST /orders/:orderId/issue` (ORD-098).
   *
   * 201, because what it leaves behind is a row that did not exist.
   *
   * ⚠️ ALL THE LINES OR NONE (ORD-003). A request for five exams that stores
   * four is a request in which nobody notices which one is missing — and the
   * missing one is the one nobody chases.
   */
  @Post()
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Componer una orden de exámenes en borrador' })
  @ApiCreatedResponse({ type: ServiceOrderDto })
  async place(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: PlaceOrderDto,
    @Req() req: Request,
  ): Promise<ServiceOrderResponse> {
    const order = await this.orders.compose(
      {
        encounterId,
        category: dto.category,
        priority: dto.priority,
        clinicalNoteText: dto.clinicalNoteText,
        lines: dto.items,
      },
      this.requester(req, 'record:write'),
    );
    return toOrderResponse(order);
  }

  /**
   * ORD-002, ORD-009. The orders of one attention, newest first.
   *
   * `record:read` AND NOT `record:write`: reading what was asked for and
   * asking for it are two acts.
   */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary: 'Listar las órdenes de la atención, borradores incluidos',
  })
  @ApiOkResponse({ type: ServiceOrderListDto })
  async ofEncounter(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ServiceOrderListResponse> {
    const items = await this.orders.ofEncounter(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toOrderResponse) };
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
