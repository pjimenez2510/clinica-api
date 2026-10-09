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

import { CashService, type CashDay } from './application/cash.service';
import type { CashDayLine, CashSessionView, PaymentView } from './domain/cash';
import { Money } from './domain/money';
import {
  CashDayDto,
  CashDayQueryDto,
  CashSessionDto,
  CloseCashSessionDto,
  CollectPaymentDto,
  PaymentDto,
  ReversePaymentDto,
  type CashDayResponse,
  type CashSessionResponse,
  type PaymentResponse,
} from './dto/cash.dto';

/**
 * billing B6. Collecting an invoice, undoing a payment, and the cashier's day.
 *
 * Under `billing:write` all four, «Caja del día» included: it is the
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

  /** BI-251. «Caja del día». */
  @Get('cash-sessions/day')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Consultar la caja propia de un día' })
  @ApiOkResponse({ type: CashDayDto })
  async day(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: CashDayQueryDto,
  ): Promise<CashDayResponse> {
    return toCashDayResponse(
      await this.cash.day(
        { siteId, day: query.date },
        { userId: this.currentUser.requireUserId() },
      ),
    );
  }

  /** BI-104, BI-105, BI-252. «Cerrar caja». */
  @Post('cash-sessions/close')
  @AnnouncesChange('billing')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cerrar la caja propia de un día' })
  @ApiCreatedResponse({ type: CashSessionDto })
  async close(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: CloseCashSessionDto,
  ): Promise<CashSessionResponse> {
    return toSessionResponse(
      await this.cash.close(
        {
          siteId,
          day: dto.date,
          declaredCash: Money.parse(dto.declaredCash),
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
    reversal: payment.reversal
      ? {
          at: payment.reversal.at.toISOString(),
          reason: payment.reversal.reason,
        }
      : null,
  };
}

function toLineResponse(line: CashDayLine) {
  return { ...line, amount: line.amount.toString() };
}

function toSessionResponse(session: CashSessionView): CashSessionResponse {
  return {
    id: session.id,
    cashDate: session.cashDate,
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

function toCashDayResponse(day: CashDay): CashDayResponse {
  return {
    date: day.day,
    payments: day.payments.map(toPaymentResponse),
    lines: day.summary.lines.map(toLineResponse),
    collectedTotal: day.summary.collectedTotal.toString(),
    expectedCash: day.summary.expectedCash.toString(),
    pendingTotal: day.pending.total.toString(),
    pendingCount: day.pending.count,
    session: day.session ? toSessionResponse(day.session) : null,
  };
}
