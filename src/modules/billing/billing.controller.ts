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
import { AnnouncesChange } from '../../shared/events/announces-change';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  ChargeCorrectionService,
  type PayerChangePreview,
} from './application/charge-correction.service';
import { ChargeDiscountService } from './application/charge-discount.service';
import { EncounterCheckoutService } from './application/encounter-checkout.service';
import {
  InvoicingService,
  type InvoiceWithVoucher,
} from './application/invoicing.service';
import {
  type AccountStatement,
  PatientAccountService,
  toLine,
} from './application/patient-account.service';
import type { AccountView, ChargeView } from './domain/billing.repository';
import type { AwaitingCheckout } from './domain/clinical-acts.port';
import { lineBase, lineTax } from './domain/charge';
import { Money, Percentage, Quantity } from './domain/money';
import type { PatientIdentity } from './domain/patient-identity';
import {
  AccountDto,
  AccountListDto,
  AccountQueryDto,
  AccountStatementDto,
  AddChargeDto,
  ApplyDiscountDto,
  DiscountPolicyDto,
  type DiscountPolicyResponse,
  ChangePayerDto,
  CloseAccountDto,
  ChargeDto,
  CheckoutDto,
  CheckoutResponseDto,
  EditChargeDto,
  InvoiceDto,
  InvoiceListDto,
  InvoiceQueryDto,
  IssueInvoiceDto,
  ResubmitInvoiceDto,
  OpenAccountDto,
  ReceiverProposalDto,
  RepricingDto,
  RepricingQueryDto,
  VoidChargeDto,
  type AccountResponse,
  AwaitingCheckoutListDto,
  AwaitingCheckoutQueryDto,
  type AwaitingCheckoutResponse,
  type PatientIdentityResponse,
  type AccountStatementResponse,
  type ChargeResponse,
  type CheckoutResponse,
  type InvoiceResponse,
  type ReceiverProposalResponse,
  type RepricingResponse,
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
// BI-238. Every write here changes what caja of the site shows.
@AnnouncesChange('billing')
export class BillingController {
  constructor(
    private readonly accounts: PatientAccountService,
    private readonly invoicing: InvoicingService,
    private readonly checkout: EncounterCheckoutService,
    private readonly corrections: ChargeCorrectionService,
    private readonly discounts: ChargeDiscountService,
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
  @AnnouncesChange('billing', 'agenda', 'waiting-room')
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
   * BI-181 to BI-183. What caja still has to look at: the site's visits that
   * ended in the last seven clinic days and are not settled, each with who it
   * is for and the account it already has.
   *
   * A READ, AND IT OPENS NOTHING. Taking a visit to caja asks who pays, and
   * that is the cashier's press on `checkout` (BI-150, BI-156). Not audited per
   * row, for the same reason as the account list (BI-133).
   */
  @Get('encounters/awaiting-checkout')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Consultar las atenciones terminadas pendientes de cobro' }) // prettier-ignore
  @ApiOkResponse({ type: AwaitingCheckoutListDto })
  async awaitingCheckout(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: AwaitingCheckoutQueryDto,
  ): Promise<{ items: AwaitingCheckoutResponse[]; olderCount: number }> {
    const { visits, olderCount } = await this.checkout.awaitingCheckout({
      siteId,
      now: new Date(),
      includeOlder: query.includeOlder,
    });
    return { items: visits.map(toAwaitingResponse), olderCount };
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
    @Req() req: Request,
  ): Promise<AccountStatementResponse> {
    // D-118: who, and from where — `req.ip` is the client because
    // `trust proxy` counts hops (see the patients controller).
    return toStatementResponse(
      await this.accounts.openStatement(
        { accountId, siteId },
        {
          userId: this.currentUser.requireUserId(),
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
      ),
    );
  }

  /** BI-033, BI-198. Los cargos sin facturar se re-tarifan con el nuevo. */
  @Patch('accounts/:accountId')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Cambiar el pagador y re-tarifar los cargos sin facturar' }) // prettier-ignore
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
        changedById: this.currentUser.requireUserId(),
      }),
    );
  }

  /**
   * BI-198. Cuánto quedaría la cuenta con otro pagador, SIN escribir: la
   * confirmación del cambio dice el total nuevo antes de aceptarlo.
   */
  @Get('accounts/:accountId/repricing')
  @RequirePermission('billing:read', 'param:siteId')
  @ApiOperation({ summary: 'Total de la cuenta con otro pagador, sin cambiarlo' }) // prettier-ignore
  @ApiOkResponse({ type: RepricingDto })
  async previewRepricing(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: RepricingQueryDto,
  ): Promise<RepricingResponse> {
    return toRepricingResponse(
      await this.corrections.previewPayerChange({
        accountId,
        siteId,
        payerId: query.payerId,
      }),
    );
  }

  /**
   * BI-071, BI-072, BI-073, BI-236, BI-237.
   *
   * Closing the account is NOT a precondition of invoicing, and invoicing is
   * not a precondition of closing the encounter clinically: chaining them
   * produces exactly the system that keeps a doctor waiting for a cashier, or
   * the other way round. What closing DOES do since D-184 is close the
   * attention that already has its discharge, in the same transaction — the
   * database does it — and, with nothing invoiced, it asks why.
   */
  @Post('accounts/:accountId/close')
  @RequirePermission('billing:write', 'param:siteId')
  // BI-238, AG-179. Closing the account closes the attention (D-184): the
  // boards see it leave.
  @AnnouncesChange('billing', 'agenda', 'waiting-room')
  // 200 and not 201: closing an account creates nothing. A POST because it is
  // a transition and not an edit of the row.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar una cuenta sin cargos pendientes' })
  @ApiOkResponse({ type: AccountDto })
  async closeAccount(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CloseAccountDto,
  ): Promise<AccountResponse> {
    return toAccountResponse(
      await this.accounts.closeAccount({
        accountId,
        siteId,
        noChargeReason: dto.noChargeReason,
        closedById: this.currentUser.requireUserId(),
      }),
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
   * BI-055, BI-056, BI-195. «Quitar»: sin motivo (D-126.1), y si llega uno se
   * guarda. Se deshace con `…/restore`.
   *
   * ⚠️ Y NO TOCA NADA CLÍNICO (BI-004). El procedimiento se hizo y el examen se
   * pidió; los dos siguen registrados exactamente igual.
   *
   * NO ES «BORRAR». La fila se conserva anulada, que es lo que permite
   * explicar por qué bajó el total de una cuenta. Y sobre un cargo ya
   * facturado se rechaza nombrando la salida: nota de crédito (BI-056).
   */
  @Post('accounts/:accountId/charges/:chargeId/void')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quitar un cargo de la cuenta' })
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
        reason: dto.reason ?? null,
        voidedById: this.currentUser.requireUserId(),
      }),
    );
  }

  /** BI-195, BI-196. «Deshacer» quitar o «No se cobra». */
  @Post('accounts/:accountId/charges/:chargeId/restore')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Devolver a la cuenta un cargo quitado' })
  @ApiOkResponse({ type: ChargeDto })
  async restoreCharge(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.corrections.restoreCharge({
        accountId,
        siteId,
        chargeId,
        changedById: this.currentUser.requireUserId(),
      }),
    );
  }

  /** BI-196. «No se cobra» un cargo de $0, sin motivo. */
  @Post('accounts/:accountId/charges/:chargeId/not-billable')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar «No se cobra» un cargo de $0' })
  @ApiOkResponse({ type: ChargeDto })
  async markNotBillable(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.corrections.markNotBillable({
        accountId,
        siteId,
        chargeId,
        changedById: this.currentUser.requireUserId(),
      }),
    );
  }

  /**
   * BI-197. Editar en el sitio un cargo sin facturar: cantidad, fecha o
   * prestación. El precio se vuelve a resolver; la versión anterior la guarda
   * la base.
   */
  @Patch('accounts/:accountId/charges/:chargeId')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Corregir un cargo sin facturar' })
  @ApiOkResponse({ type: ChargeDto })
  async editCharge(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: EditChargeDto,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.corrections.editCharge({
        accountId,
        siteId,
        chargeId,
        changedById: this.currentUser.requireUserId(),
        billableServiceId: dto.billableServiceId,
        serviceDate: dto.serviceDate,
        quantity:
          dto.quantity === undefined ? undefined : Quantity.parse(dto.quantity),
      }),
    );
  }

  /**
   * BI-062, BI-245. Lo que el diálogo de descuento sabe antes de pedir: el
   * límite de quien pide en esta sede y a quién puede pedírselo por encima.
   * `billing:write` y no `billing:read`: es parte de rebajar, y la lista de
   * quién autoriza no es de quien sólo mira.
   */
  @Get('accounts/:accountId/discount-policy')
  @RequirePermission('billing:write', 'param:siteId')
  @ApiOperation({ summary: 'Consultar el límite de descuento propio y quién lo autoriza' }) // prettier-ignore
  @ApiOkResponse({ type: DiscountPolicyDto })
  async discountPolicy(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<DiscountPolicyResponse> {
    const policy = await this.discounts.discountPolicy({
      accountId,
      siteId,
      userId: this.currentUser.requireUserId(),
    });
    return {
      maxDiscountPercentage: policy.maxDiscountPercentage.toString(),
      authorisers: policy.authorisers,
    };
  }

  /**
   * BI-060 a BI-066, BI-244, BI-246. Pone, reemplaza o —con cero— quita el
   * descuento de una línea confirmada. Por encima del límite de quien lo pide
   * hace falta otra persona con `billing:discount-override` en la sede, y la
   * línea queda con los dos nombres; nadie se autoriza a sí mismo.
   */
  @Post('accounts/:accountId/charges/:chargeId/discount')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Poner o quitar el descuento de un cargo' })
  @ApiOkResponse({ type: ChargeDto })
  async applyDiscount(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: ApplyDiscountDto,
    @Req() req: Request,
  ): Promise<ChargeResponse> {
    return toChargeResponse(
      await this.discounts.applyDiscount({
        accountId,
        siteId,
        chargeId,
        discount:
          dto.percentage === undefined
            ? { amount: Money.parse(dto.amount ?? '0') }
            : { percentage: Percentage.parse(dto.percentage) },
        reason: dto.reason ?? null,
        authorisedById: dto.authorisedById ?? null,
        requester: {
          userId: this.currentUser.requireUserId(),
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
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
  ): Promise<{
    items: InvoiceResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { items, total } = await this.invoicing.listInvoices({
      siteId,
      accountId: query.accountId,
      filter: {
        search: query.search,
        issuedFrom: query.from,
        issuedTo: query.to,
      },
      page: query.page,
      pageSize: query.pageSize,
    });
    return {
      items: items.map(toInvoiceResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
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
  // BI-238, SRI-092. A new invoice is a new row of the SRI monitor.
  @AnnouncesChange('billing', 'sri')
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
        paymentMethod: dto.paymentMethod,
        expectedChargeIds: dto.chargeIds,
        expectedTotal:
          dto.expectedTotal === undefined
            ? undefined
            : Money.parse(dto.expectedTotal),
      },
      { userId: this.currentUser.requireUserId() },
    );

    return toInvoiceResponse(invoice);
  }

  /**
   * BI-216, SRI-090 (D-093 B). Corrects the receiver or the payment method of
   * an invoice the SRI returned or did not authorise, and re-sends it with
   * the same key. A POST of an action and not a PATCH of the invoice: there
   * is still no edit of an invoice (BI-090), and this one is refused in any
   * other status, by the service and by the database (BI-217).
   */
  @Post('invoices/:invoiceId/resubmission')
  @AnnouncesChange('billing', 'sri')
  @RequirePermission('billing:write', 'param:siteId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Corregir y reenviar una factura devuelta por el SRI',
  })
  @ApiOkResponse({ type: InvoiceDto })
  async resubmitInvoice(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: ResubmitInvoiceDto,
  ): Promise<InvoiceResponse> {
    return toInvoiceResponse(
      await this.invoicing.correctAndResend(
        {
          invoiceId,
          siteId,
          receiver: dto.receiver,
          paymentMethod: dto.paymentMethod,
        },
        { userId: this.currentUser.requireUserId() },
      ),
    );
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
/**
 * The document type is narrowed to the four definitive ones: the adapter never
 * hands over the `PROVISIONAL` marker of a newborn as a document.
 */
function toIdentityResponse(
  identity: PatientIdentity,
): PatientIdentityResponse {
  return {
    ...identity,
    document: identity.document
      ? {
          type: identity.document.type as NonNullable<
            PatientIdentityResponse['document']
          >['type'],
          value: identity.document.value,
        }
      : null,
  };
}

function toAwaitingResponse(visit: AwaitingCheckout): AwaitingCheckoutResponse {
  return {
    encounterId: visit.encounterId,
    status: visit.status,
    endedAt: visit.endedAt.toISOString(),
    clinicallyAttended: visit.clinicallyAttended,
    patient: toIdentityResponse(visit.patient),
    account: visit.account,
    unchargedExams: visit.unchargedExams,
  };
}

function toAccountResponse(account: AccountView): AccountResponse {
  return {
    id: account.id,
    siteId: account.siteId,
    patientId: account.patientId,
    patient: toIdentityResponse(account.patient),
    encounterId: account.encounterId,
    payerId: account.payerId,
    priceListId: account.priceListId,
    status: account.status,
    openedAt: account.openedAt.toISOString(),
    closedAt: account.closedAt?.toISOString() ?? null,
    noChargeReason: account.noChargeReason,
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
    invoiceableTotals: toTotalsResponse(statement.invoiceableTotals),
    draftOrders: statement.draftOrders.map((draft) => ({
      ...draft,
      savedAt: draft.savedAt.toISOString(),
    })),
    consultationOutdated: statement.consultationOutdated,
    proceduresOutdated: statement.proceduresOutdated,
    encounterStatus:
      statement.encounterStatus as AccountStatementResponse['encounterStatus'],
    closesEncounter: statement.closesEncounter,
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
function personRef(
  id: string | null,
  name: string | null,
): { id: string; name: string } | null {
  return id === null ? null : { id, name: name ?? '' };
}

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
    // BI-066, SC-021. Who and when, by name, so the line says it.
    discountAppliedBy: personRef(charge.discountAppliedById, charge.discountAppliedByName), // prettier-ignore
    discountAppliedAt: charge.discountAppliedAt?.toISOString() ?? null,
    discountAuthorisedBy: personRef(charge.discountAuthorisedById, charge.discountAuthorisedByName), // prettier-ignore
    discountAuthorisedAt: charge.discountAuthorisedAt?.toISOString() ?? null,
    status: charge.status,
    // BI-153. De dónde viene la línea, y qué acto nombra.
    origin: charge.origin,
    encounterProcedureId: charge.encounterProcedureId,
    serviceOrderItemId: charge.serviceOrderItemId,
    voidedAt: charge.voidedAt?.toISOString() ?? null,
    voidReason: charge.voidReason,
    invoiceId: charge.invoiceId,
    correctsChargeItemId: charge.correctsChargeItemId,
    // BI-058. Derived on the way out from the FROZEN values, so the client
    // never has to do decimal arithmetic in JavaScript to show a line.
    lineTotal: lineBase(line).toString(),
    lineTax: lineTax(line).toString(),
  };
}

/** BI-198. Amounts as strings (BI-001). */
function toRepricingResponse(preview: PayerChangePreview): RepricingResponse {
  return {
    currentTotal: preview.currentTotal.toString(),
    newTotal: preview.newTotal?.toString() ?? null,
    lines: preview.lines.map((line) => ({
      chargeId: line.chargeId,
      unitAmount: line.unitAmount?.toString() ?? null,
    })),
  };
}

/**
 * The invoice as served: the receiver block flattened and the five totals as
 * strings (BI-001).
 */
function toInvoiceResponse(invoice: InvoiceWithVoucher): InvoiceResponse {
  return {
    id: invoice.id,
    accountId: invoice.accountId,
    siteId: invoice.siteId,
    emissionPointId: invoice.emissionPointId,
    sequential: invoice.sequential,
    documentNumber: invoice.documentNumber,
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
    paymentMethod: invoice.paymentMethod,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    authorisedAt: invoice.authorisedAt?.toISOString() ?? null,
    electronic: invoice.electronic
      ? {
          ...invoice.electronic,
          authorisedAt: invoice.electronic.authorisedAt?.toISOString() ?? null,
        }
      : null,
  };
}
