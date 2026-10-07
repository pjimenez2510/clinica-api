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
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  CreditNoteService,
  type CreditNoteWithVoucher,
} from './application/credit-note.service';
import {
  CreditNoteListDto,
  CreditNoteQueryDto,
  IssueCreditNoteDto,
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
  ): Promise<IssuedCreditNoteResponse> {
    const issued = await this.creditNotes.issue(
      {
        invoiceId,
        siteId,
        chargeIds: dto.chargeIds,
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText,
      },
      { userId: this.currentUser.requireUserId() },
    );
    return {
      creditNote: toCreditNoteResponse(issued.creditNote),
      rebilledAccountId: issued.rebilledAccountId,
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
    siteId: note.siteId,
    emissionPointId: note.emissionPointId,
    sequential: note.sequential,
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
        }
      : null,
  };
}
