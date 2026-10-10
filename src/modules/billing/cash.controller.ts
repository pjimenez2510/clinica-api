import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { AnnouncesChange } from '../../shared/events/announces-change';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { clinicalDateOf } from '../../shared/domain/clinic-time';

import { CashService, type CashTurn } from './application/cash.service';
import type { CashLine, CashSessionView, PaymentView } from './domain/cash';
import { Money } from './domain/money';
import {
  CashSessionDto,
  CashSessionListDto,
  CashSessionsQueryDto,
  CashTurnDto,
  CloseCashSessionDto,
  CollectPaymentDto,
  PaymentDto,
  ReversePaymentDto,
  type CashSessionListResponse,
  type CashSessionResponse,
  type CashTurnResponse,
  type PaymentResponse,
} from './dto/cash.dto';

/**
 * billing B6. Collecting an invoice, undoing a payment, and the cashier's turn.
 *
 * Under `billing:write` all five, «Caja» included: it is the
 * cashier's own drawer, and a role that only reads billing has none. Each
 * write announces `billing`, so a second caja screen sees the balance change
 * without reloading (BI-238).
 */
@ApiTags('billing')
@Controller({ path: 'billing/sites/:siteId', version: '1' })
export class CashController {
  constructor(
    private readonly cash: CashService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-248. «Cobrar» on an invoice with a balance. */
  @Post('invoices/:invoiceId/payments')
  @AnnouncesChange('billing')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un cobro de una factura' })
  @ApiCreatedResponse({ type: PaymentDto })
  async collect(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: CollectPaymentDto,
  ): Promise<PaymentResponse> {
    return toPaymentResponse(
      await this.cash.collect(
        {
          siteId,
          invoiceId,
          paymentMethodId: dto.paymentMethodId,
          amount:
            dto.amount === undefined ? undefined : Money.parse(dto.amount),
          reference: dto.reference,
        },
        { userId: this.currentUser.requireUserId() },
      ),
    );
  }

  /** BI-102. «Revertir», with its reason. */
  @Post('payments/:paymentId/reversal')
  @AnnouncesChange('billing')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revertir un cobro propio con su motivo' })
  @ApiOkResponse({ type: PaymentDto })
  async reverse(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: ReversePaymentDto,
  ): Promise<PaymentResponse> {
    return toPaymentResponse(
      await this.cash.reverse(
        { siteId, paymentId, reason: dto.reason },
        { userId: this.currentUser.requireUserId() },
      ),
    );
  }

  /** BI-251. «Caja»: the open turn. */
  @Get('cash-sessions/open')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Consultar el turno abierto de la caja propia' })
  @ApiOkResponse({ type: CashTurnDto })
  async openTurn(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<CashTurnResponse> {
    return toCashTurnResponse(
      await this.cash.openTurn(
        { siteId },
        { userId: this.currentUser.requireUserId() },
      ),
    );
  }

  /** BI-258. The closes of a day, under the open turn. */
  @Get('cash-sessions')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Consultar los cierres propios de un día' })
  @ApiOkResponse({ type: CashSessionListDto })
  async closesOfDay(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: CashSessionsQueryDto,
  ): Promise<CashSessionListResponse> {
    const day = query.date ?? clinicalDateOf(new Date());
    const sessions = await this.cash.closesOfDay(
      { siteId, day },
      { userId: this.currentUser.requireUserId() },
    );
    return { date: day, sessions: sessions.map(toSessionResponse) };
  }

  /** BI-104, BI-105, BI-252. «Cerrar caja»: the open turn. */
  @Post('cash-sessions/close')
  @AnnouncesChange('billing')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cerrar el turno abierto de la caja propia' })
  @ApiCreatedResponse({ type: CashSessionDto })
  async close(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: CloseCashSessionDto,
  ): Promise<CashSessionResponse> {
    return toSessionResponse(
      await this.cash.close(
        {
          siteId,
          declaredCash: Money.parse(dto.declaredCash),
          previousSessionId: dto.previousSessionId,
          seenExpectedCash:
            dto.expectedCash === undefined
              ? undefined
              : Money.parse(dto.expectedCash),
          note: dto.note,
        },
        { userId: this.currentUser.requireUserId() },
      ),
    );
  }
}

function toPaymentResponse(payment: PaymentView): PaymentResponse {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    invoiceDocumentNumber: payment.invoiceDocumentNumber,
    buyerName: payment.buyerName,
    paymentMethodId: payment.paymentMethodId,
    paymentMethodName: payment.paymentMethodName,
    sriCode: payment.sriCode,
    amount: payment.amount.toString(),
    reference: payment.reference,
    receivedAt: payment.receivedAt.toISOString(),
    cashDate: payment.cashDate,
    closed: payment.cashSessionId !== null,
    reversal: payment.reversal
      ? {
          at: payment.reversal.at.toISOString(),
          reason: payment.reversal.reason,
        }
      : null,
  };
}

function toLineResponse(line: CashLine) {
  return { ...line, amount: line.amount.toString() };
}

function toSessionResponse(session: CashSessionView): CashSessionResponse {
  return {
    id: session.id,
    previousClosedAt: session.previousClosedAt?.toISOString() ?? null,
    closedAt: session.closedAt.toISOString(),
    closedByName: session.userName,
    lines: session.lines.map(toLineResponse),
    collectedTotal: session.collectedTotal.toString(),
    expectedCash: session.expectedCash.toString(),
    declaredCash: session.declaredCash.toString(),
    difference: session.difference.toString(),
    pendingTotal: session.pendingTotal.toString(),
    pendingCount: session.pendingCount,
    note: session.note,
  };
}

function toCashTurnResponse(turn: CashTurn): CashTurnResponse {
  return {
    previousSession: turn.previousSession
      ? {
          id: turn.previousSession.id,
          closedAt: turn.previousSession.closedAt.toISOString(),
        }
      : null,
    payments: turn.payments.map(toPaymentResponse),
    lines: turn.summary.lines.map(toLineResponse),
    collectedTotal: turn.summary.collectedTotal.toString(),
    expectedCash: turn.summary.expectedCash.toString(),
    pendingTotal: turn.pending.total.toString(),
    pendingCount: turn.pending.count,
  };
}
