import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { AnnouncesChange } from '../../shared/events/announces-change';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  CreditNoteService,
  type CreditNoteWithVoucher,
} from './application/credit-note.service';
import {
  CorrectCreditNoteDto,
  CreditNoteDto,
  CreditNoteListDto,
  CreditNoteQueryDto,
  IssueCreditNoteDto,
  WithdrawCreditNoteDto,
  IssuedCreditNoteDto,
  type CreditNoteResponse,
  type IssuedCreditNoteResponse,
} from './dto/credit-note.dto';

/**
 * BI-208 to BI-218. Correcting an authorised invoice with a credit note.
 *
 * Its own controller because its own permission: `billing:credit-note`
 * (BI-091, D-A-007) and not `billing:write` — issuing a document and undoing
 * one are different acts and need not be done by the same person.
 */
@ApiTags('billing')
@Controller({ path: 'billing/sites/:siteId', version: '1' })
export class CreditNoteController {
  constructor(
    private readonly creditNotes: CreditNoteService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-208. «Corregir». */
  @Post('invoices/:invoiceId/credit-notes')
  // BI-238, SRI-092. The invoice changes, and a voucher is born.
  @AnnouncesChange('billing', 'sri')
  @RequirePermission('billing:credit-note', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Corregir una factura autorizada con una nota de crédito',
  })
  @ApiCreatedResponse({ type: IssuedCreditNoteDto })
  async issue(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: IssueCreditNoteDto,
    @Req() req: Request,
  ): Promise<IssuedCreditNoteResponse> {
    const issued = await this.creditNotes.issue(
      {
        invoiceId,
        siteId,
        chargeIds: dto.chargeIds,
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText,
      },
      // BI-132, BI-273: who, and from where, into the credit note's transaction.
      {
        userId: this.currentUser.requireUserId(),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
    );
    return {
      creditNote: toCreditNoteResponse(issued.creditNote),
      rebilledAccountId: issued.rebilledAccountId,
    };
  }

  /** BI-303, SRI-103. «Editar» the reason of a returned note, and re-send it. */
  @Patch('credit-notes/:creditNoteId')
  @AnnouncesChange('billing', 'sri')
  @RequirePermission('billing:credit-note', 'param:siteId')
  @ApiOperation({
    summary:
      'Corregir el motivo de una nota de crédito devuelta y reenviarla con su clave',
  })
  @ApiOkResponse({ type: CreditNoteDto })
  async correct(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('creditNoteId', ParseUUIDPipe) creditNoteId: string,
    @Body() dto: CorrectCreditNoteDto,
    @Req() req: Request,
  ): Promise<CreditNoteResponse> {
    return toCreditNoteResponse(
      await this.creditNotes.correctAndResend(
        {
          creditNoteId,
          siteId,
          reasonCode: dto.reasonCode,
          reasonText: dto.reasonText,
        },
        this.requester(req),
      ),
    );
  }

  /** BI-304. «Desistir» of a returned note: its lines are released. */
  @Post('credit-notes/:creditNoteId/withdrawal')
  @AnnouncesChange('billing', 'sri')
  @RequirePermission('billing:credit-note', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Desistir de una nota de crédito devuelta: libera sus líneas y quita lo que esperaba',
  })
  @ApiOkResponse({ type: CreditNoteDto })
  async withdraw(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('creditNoteId', ParseUUIDPipe) creditNoteId: string,
    @Body() dto: WithdrawCreditNoteDto,
    @Req() req: Request,
  ): Promise<CreditNoteResponse> {
    return toCreditNoteResponse(
      await this.creditNotes.withdraw(
        { creditNoteId, siteId, reason: dto.reason },
        this.requester(req),
      ),
    );
  }

  /** BI-132, BI-273: who, and from where, into the note's transaction. */
  private requester(req: Request) {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }

  /** BI-218. */
  @Get('credit-notes')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar las notas de crédito de una sede' })
  @ApiOkResponse({ type: CreditNoteListDto })
  async list(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: CreditNoteQueryDto,
  ): Promise<{
    items: CreditNoteResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { items, total } = await this.creditNotes.list({
      siteId,
      invoiceId: query.invoiceId,
      filter: {
        search: query.search,
        issuedFrom: query.from,
        issuedTo: query.to,
      },
      page: query.page,
      pageSize: query.pageSize,
    });
    return {
      items: items.map(toCreditNoteResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

/** Every amount a string (BI-001). */
function toCreditNoteResponse(note: CreditNoteWithVoucher): CreditNoteResponse {
  return {
    id: note.id,
    invoiceId: note.invoiceId,
    invoiceSequential: note.invoiceSequential,
    invoiceDocumentNumber: note.invoiceDocumentNumber,
    siteId: note.siteId,
    emissionPointId: note.emissionPointId,
    sequential: note.sequential,
    documentNumber: note.documentNumber,
    accessKey: note.accessKey,
    reasonCode: note.reasonCode,
    reason: note.reason,
    buyerIdentificationType: note.receiver.buyerIdentificationType,
    buyerIdentification: note.receiver.buyerIdentification,
    buyerName: note.receiver.buyerName,
    buyerEmail: note.receiver.buyerEmail,
    totals: {
      subtotalTaxed: note.totals.subtotalTaxed.toString(),
      subtotalUntaxed: note.totals.subtotalUntaxed.toString(),
      discountTotal: note.totals.discountTotal.toString(),
      taxTotal: note.totals.taxTotal.toString(),
      total: note.totals.total.toString(),
    },
    status: note.status,
    withdrawalReason: note.withdrawalReason,
    issuedAt: note.issuedAt.toISOString(),
    lines: note.lines.map((line) => ({
      chargeItemId: line.chargeItemId,
      serviceCode: line.serviceCode,
      description: line.description,
      quantity: line.quantity.toString(),
      unitAmount: line.unitAmount.toString(),
      discountAmount: line.discountAmount.toString(),
      taxSriCode: line.taxSriCode,
      netAmount: line.netAmount.toString(),
      taxAmount: line.taxAmount.toString(),
    })),
    electronic: note.electronic
      ? {
          ...note.electronic,
          authorisedAt: note.electronic.authorisedAt?.toISOString() ?? null,
          renumberedFrom: note.electronic.renumberedFrom.map((renumbering) => ({
            ...renumbering,
            at: renumbering.at.toISOString(),
          })),
        }
      : null,
  };
}
