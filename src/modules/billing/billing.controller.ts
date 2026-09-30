import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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

import { EncounterCheckoutService } from './application/encounter-checkout.service';
import { InvoicingService } from './application/invoicing.service';
import {
  type AccountStatement,
  PatientAccountService,
  toLine,
} from './application/patient-account.service';
import type {
  AccountView,
  ChargeView,
  InvoiceView,
} from './domain/billing.repository';
import { lineBase, lineTax } from './domain/charge';
import { Quantity } from './domain/money';
import {
  AccountDto,
  AccountListDto,
  AccountQueryDto,
  AccountStatementDto,
  AddChargeDto,
  ChangePayerDto,
  ChargeDto,
  CheckoutDto,
  CheckoutResponseDto,
  InvoiceDto,
  InvoiceListDto,
  InvoiceQueryDto,
  IssueInvoiceDto,
  OpenAccountDto,
  ReceiverProposalDto,
  VoidChargeDto,
  type AccountResponse,
  type AccountStatementResponse,
  type ChargeResponse,
  type CheckoutResponse,
  type InvoiceResponse,
  type ReceiverProposalResponse,
} from './dto/billing.dto';

/**
 * What one visit owes, and the document that settles it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO ROUTE HERE THAT MODIFIES OR DELETES AN INVOICE. BI-090.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That absence is the requirement and not an omission somebody could
 * «complete». D-A-007: the SRI does not allow modifying or deleting an
 * authorised invoice, so this system has no «editar factura» — and a route
 * that existed without a screen would be used anyway. Correcting is a credit
 * note: another act, another permission, a mandatory reason, delivery B3.
 *
 * THE SITE IS IN THE URL, so the guard settles BI-131 before any pipe runs.
 * Guards run before pipes, which means the body is unvalidated at that moment
 * and unusable for an authorisation decision; only a route parameter is
 * readable that early. Every route here therefore declares `param:siteId`, and
 * the route-coverage test fails if one of them says anything else.
 *
 * ⚠️ AND NOTHING HERE IS A PRECONDITION OF CARE (Ley 77 art. 9, BI-003,
 * BI-120). No clinical route calls any of these; a patient is received,
 * stabilised, treated and discharged whether or not an account exists.
 */
@ApiTags('billing')
@Controller({ path: 'billing/sites/:siteId', version: '1' })
export class BillingController {
  constructor(
    private readonly accounts: PatientAccountService,
    private readonly invoicing: InvoicingService,
    private readonly checkout: EncounterCheckoutService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * BI-150 a BI-158. EL PASO DE LA CONSULTA A LA CAJA.
   *
   * Una atención entra y sale su cuenta con lo que se hizo ya propuesto: la
   * consulta según su especialidad y su tipo, los procedimientos registrados y
   * los exámenes pedidos. Pulsar dos veces no duplica nada.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * ⚠️ ESTA RUTA NO BLOQUEA NADA CLÍNICO. Ley 77 art. 9, BI-003, BI-156.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Ningún flujo clínico la llama y cerrar la atención no depende de que
   * responda. El médico termina cuando termina; que alguien pulse «enviar a
   * caja» —antes, después o nunca— no cambia la atención ni la nota que la
   * registra. Y lo que devuelve son PROPUESTAS: cada cargo derivado nace
   * `PLANNED` y la factura sólo se lleva los confirmados (BI-152).
   *
   * POST y no GET aunque parezca una consulta: abre una cuenta y escribe
   * cargos. Que sea idempotente no la hace segura de repetir sin efectos —
   * la primera vez los tiene, y todos.
   */
  @Post('encounters/:encounterId/checkout')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enviar una atención a caja con sus cargos propuestos' }) // prettier-ignore
  @ApiOkResponse({ type: CheckoutResponseDto })
  async sendToCashier(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutResponse> {
    const result = await this.checkout.sendToCashier({
      siteId,
      encounterId,
      payerId: dto.payerId,
      userId: this.currentUser.requireUserId(),
    });

    return {
      statement: toStatementResponse(result.statement),
      raisedChargeIds: result.raisedChargeIds,
      skipped: result.skipped,
    };
  }

  /**
   * BI-070, BI-133. The cashier's list of the day.
   *
   * NOT AUDITED PER ROW (BI-133, REQ-111). Burying the accesses that matter
   * under the day's cashier listing is the most effective way to make the
   * evidence the LOPDP demands useless. Opening a chart is the accountable
   * act, and it is `GET /patients/:id` that records it.
   */
  @Get('accounts')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar las cuentas de una sede' })
  @ApiOkResponse({ type: AccountListDto })
  async listAccounts(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: AccountQueryDto,
  ): Promise<{ items: AccountResponse[] }> {
    const items = await this.accounts.listAccounts({
      siteId,
      patientId: query.patientId,
      status: query.status,
    });
    return { items: items.map(toAccountResponse) };
  }

  /** BI-070. Opens the account with its payer already decided. */
  @Post('accounts')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abrir la cuenta de un paciente' })
  @ApiCreatedResponse({ type: AccountDto })
  async openAccount(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: OpenAccountDto,
  ): Promise<AccountResponse> {
    return toAccountResponse(
      await this.accounts.openAccount({
        siteId,
        patientId: dto.patientId,
        encounterId: dto.encounterId ?? null,
        payerId: dto.payerId,
      }),
    );
  }

  /** BI-074. The account, its charges and the total DERIVED from them. */
  @Get('accounts/:accountId')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar una cuenta con sus cargos y su total' })
  @ApiOkResponse({ type: AccountStatementDto })
  async statement(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<AccountStatementResponse> {
    return toStatementResponse(
      await this.accounts.statement({ accountId, siteId }),
    );
  }

  /** BI-033. */
  @Patch('accounts/:accountId')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Cambiar el pagador de una cuenta sin cargos' })
  @ApiOkResponse({ type: AccountDto })
  async changePayer(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: ChangePayerDto,
  ): Promise<AccountResponse> {
    return toAccountResponse(
      await this.accounts.changePayer({
        accountId,
        siteId,
        payerId: dto.payerId,
      }),
    );
  }

  /**
   * BI-071, BI-072, BI-073.
   *
   * Closing the account is NOT a precondition of invoicing, and invoicing is
   * not a precondition of closing the encounter clinically: chaining them
   * produces exactly the system that keeps a doctor waiting for a cashier, or
   * the other way round.
   */
  @Post('accounts/:accountId/close')
  @RequirePermission('billing:write', 'param:siteId')
  // 200 and not 201: closing an account creates nothing. A POST because it is
  // a transition and not an edit of the row.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar una cuenta sin cargos pendientes' })
  @ApiOkResponse({ type: AccountDto })
  async closeAccount(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<AccountResponse> {
    return toAccountResponse(
      await this.accounts.closeAccount({ accountId, siteId }),
    );
  }

  /**
   * BI-015, BI-047, BI-050, BI-052, BI-057. THE CHARGE, and it freezes.
   *
   * The response carries the frozen block back — the unit amount, the tax code
   * and percentage of that day, and the price row they came from — because
   * that is what the cashier's screen has to show and what an audit reads
   * years later. Nothing in it is looked up at serving time.
   */
  @Post('accounts/:accountId/charges')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un cargo con el precio del día del servicio' }) // prettier-ignore
  @ApiCreatedResponse({ type: ChargeDto })
  async addCharge(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: AddChargeDto,
  ): Promise<ChargeResponse> {
    const charge = await this.accounts.addCharge({
      accountId,
      siteId,
      billableServiceId: dto.billableServiceId,
      encounterId: dto.encounterId ?? null,
      serviceDate: dto.serviceDate,
      quantity: Quantity.parse(dto.quantity),
      createdById: this.currentUser.requireUserId(),
    });

    return toChargeResponse(charge);
  }

  /**
   * BI-152. «Sí, esto se cobra»: una línea propuesta pasa a facturable.
   *
   * ⚠️ ESTE PASO ES LA REVISIÓN, y por eso existe la ruta. Un sistema que
   * facturara lo que dedujo, sin que nadie mire, cobra de más el día que el
   * catálogo esté mal — y a quien cobra de más es a un paciente que no tiene
   * cómo saberlo. Nada se recalcula aquí: el importe se congeló el día del
   * servicio (BI-050) y confirmar es una persona haciéndose cargo de la línea.
   */
  @Post('accounts/:accountId/charges/:chargeId/confirm')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar un cargo propuesto para que se pueda facturar' }) // prettier-ignore
  @ApiOkResponse({ type: ChargeDto })
  async confirmCharge(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.accounts.confirmCharge({ accountId, siteId, chargeId }),
    );
  }

  /**
   * BI-055, BI-056, BI-059. «Esto no se cobra»: se anula CON MOTIVO.
   *
   * ⚠️ Y NO TOCA NADA CLÍNICO (BI-004). El procedimiento se hizo y el examen se
   * pidió; los dos siguen registrados exactamente igual. Lo que esta ruta dice
   * es que la clínica no lo cobra — una decisión sobre dinero, de una persona,
   * con un motivo que se guarda y no sólo se exige.
   *
   * NO ES «BORRAR». La fila se conserva anulada, que es lo que permite
   * explicar por qué bajó el total de una cuenta. Y sobre un cargo ya
   * facturado se rechaza nombrando la salida: nota de crédito (BI-056).
   */
  @Post('accounts/:accountId/charges/:chargeId/void')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quitar un cargo de la cuenta indicando el motivo' })
  @ApiOkResponse({ type: ChargeDto })
  async voidCharge(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: VoidChargeDto,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.accounts.voidCharge({
        accountId,
        siteId,
        chargeId,
        reason: dto.reason,
        voidedById: this.currentUser.requireUserId(),
      }),
    );
  }

  /**
   * BI-082. What the screen OFFERS as receiver — never what it applies.
   *
   * A route of its own rather than a field of the account: BI-080 demands the
   * receiver be stated on issuance, and a proposal served inside the account
   * is one copy-paste away from becoming a default nobody chose.
   */
  @Get('accounts/:accountId/invoice-receiver')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Proponer el receptor de la factura de una cuenta' })
  @ApiOkResponse({ type: ReceiverProposalDto })
  async receiverProposal(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<ReceiverProposalResponse> {
    const proposal = await this.invoicing.proposedReceiver({
      accountId,
      siteId,
    });

    return {
      identificationType: proposal.identificationType ?? null,
      identification: proposal.identification ?? null,
      name: proposal.name ?? null,
    };
  }

  /** BI-133, BI-135. */
  @Get('invoices')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar las facturas de una sede' })
  @ApiOkResponse({ type: InvoiceListDto })
  async listInvoices(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: InvoiceQueryDto,
  ): Promise<{ items: InvoiceResponse[] }> {
    const items = await this.invoicing.listInvoices({
      siteId,
      accountId: query.accountId,
    });
    return { items: items.map(toInvoiceResponse) };
  }

  /**
   * BI-080 a BI-089. Issues the invoice of an account.
   *
   * ⚠️ THE RECEIVER IS DECLARED, NEVER DEFAULTED, and «Consumidor Final» is an
   * explicit exception carrying its own confirmation and reason (BI-081).
   * Emitting that way destroys the patient's personal-expense rebate and,
   * since 2026, cannot even be voided — so the confirmation is the SERVER'S
   * and not a dialog's: a warning that lives on a screen disappears the moment
   * this route is called from a cashier shortcut, which is precisely what will
   * happen.
   */
  @Post('invoices')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emitir la factura de una cuenta' })
  @ApiCreatedResponse({ type: InvoiceDto })
  async issueInvoice(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() dto: IssueInvoiceDto,
  ): Promise<InvoiceResponse> {
    const invoice = await this.invoicing.issueInvoice(
      {
        accountId: dto.accountId,
        siteId,
        emissionPointId: dto.emissionPointId,
        receiver: dto.receiver,
      },
      { userId: this.currentUser.requireUserId() },
    );

    return toInvoiceResponse(invoice);
  }

  /** BI-135. */
  @Get('invoices/:invoiceId')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar una factura emitida' })
  @ApiOkResponse({ type: InvoiceDto })
  async findInvoice(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceResponse> {
    return toInvoiceResponse(
      await this.invoicing.findInvoice({ invoiceId, siteId }),
    );
  }
}

/**
 * The account as served. Instants go out as ISO strings; there is no total on
 * it (BI-074), the statement carries it.
 */
function toAccountResponse(account: AccountView): AccountResponse {
  return {
    id: account.id,
    siteId: account.siteId,
    patientId: account.patientId,
    encounterId: account.encounterId,
    payerId: account.payerId,
    priceListId: account.priceListId,
    status: account.status,
    openedAt: account.openedAt.toISOString(),
    closedAt: account.closedAt?.toISOString() ?? null,
  };
}

/**
 * The account, its charges (voided ones included, BI-055) and both derived
 * totals: what counts, and what is still only proposed.
 */
function toStatementResponse(
  statement: AccountStatement,
): AccountStatementResponse {
  return {
    account: toAccountResponse(statement.account),
    charges: statement.charges.map(toChargeResponse),
    totals: toTotalsResponse(statement.totals),
    proposedTotals: toTotalsResponse(statement.proposedTotals),
  };
}

/** The five figures, each as a decimal string (BI-001). */
function toTotalsResponse(
  totals: AccountStatement['totals'],
): AccountStatementResponse['totals'] {
  return {
    subtotalTaxed: totals.subtotalTaxed.toString(),
    subtotalUntaxed: totals.subtotalUntaxed.toString(),
    discountTotal: totals.discountTotal.toString(),
    taxTotal: totals.taxTotal.toString(),
    total: totals.total.toString(),
  };
}

/**
 * A charge as served, every amount a string (BI-001).
 *
 * `lineTotal` is the line's base — gross minus discount, BEFORE tax — and
 * `lineTax` its tax rounded on the line (BI-058); both come from the frozen
 * columns. Who created the line and who authorised a discount are not in the
 * response.
 */
function toChargeResponse(charge: ChargeView): ChargeResponse {
  const line = toLine(charge);

  return {
    id: charge.id,
    accountId: charge.accountId,
    billableServiceId: charge.billableServiceId,
    encounterId: charge.encounterId,
    serviceDate: charge.serviceDate,
    quantity: charge.quantity.toString(),
    unitAmount: charge.unitAmount.toString(),
    resolvedPriceId: charge.resolvedPriceId,
    serviceDisplay: charge.serviceDisplay,
    taxSriCode: charge.taxSriCode,
    taxPercentage: charge.taxPercentage?.toString() ?? null,
    discountAmount: charge.discountAmount.toString(),
    discountReason: charge.discountReason,
    status: charge.status,
    // BI-153. De dónde viene la línea, y qué acto nombra.
    origin: charge.origin,
    encounterProcedureId: charge.encounterProcedureId,
    serviceOrderItemId: charge.serviceOrderItemId,
    voidedAt: charge.voidedAt?.toISOString() ?? null,
    voidReason: charge.voidReason,
    // BI-058. Derived on the way out from the FROZEN values, so the client
    // never has to do decimal arithmetic in JavaScript to show a line.
    lineTotal: lineBase(line).toString(),
    lineTax: lineTax(line).toString(),
  };
}

/**
 * The invoice as served: the receiver block flattened and the five totals as
 * strings (BI-001).
 */
function toInvoiceResponse(invoice: InvoiceView): InvoiceResponse {
  return {
    id: invoice.id,
    accountId: invoice.accountId,
    siteId: invoice.siteId,
    emissionPointId: invoice.emissionPointId,
    sequential: invoice.sequential,
    accessKey: invoice.accessKey,
    buyerIdentificationType: invoice.receiver.buyerIdentificationType,
    buyerIdentification: invoice.receiver.buyerIdentification,
    buyerName: invoice.receiver.buyerName,
    buyerEmail: invoice.receiver.buyerEmail,
    isFinalConsumer: invoice.receiver.isFinalConsumer,
    totals: {
      subtotalTaxed: invoice.totals.subtotalTaxed.toString(),
      subtotalUntaxed: invoice.totals.subtotalUntaxed.toString(),
      discountTotal: invoice.totals.discountTotal.toString(),
      taxTotal: invoice.totals.taxTotal.toString(),
      total: invoice.totals.total.toString(),
    },
    status: invoice.status,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    authorisedAt: invoice.authorisedAt?.toISOString() ?? null,
  };
}
