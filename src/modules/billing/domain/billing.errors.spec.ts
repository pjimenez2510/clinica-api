import { describe, expect, it } from 'vitest';

import {
  BusinessRuleViolation,
  ConflictError,
  type DomainError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import {
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import * as errors from './billing.errors';

/**
 * The contract of every billing error: its `code`, its category — which is
 * what `problem-details.filter.ts` turns into a status — and what it does and
 * does not say.
 *
 * ⚠️ THE CATEGORY IS THE STATUS. There are no HTTP numbers in the domain, so
 * asserting the base class is asserting the status the client will branch on:
 * `NotFoundError` → 404, `ConflictError` → 409, `ValidationError` and
 * `BusinessRuleViolation` → 422. Getting one wrong is a contract change nobody
 * would notice until an integrator did.
 *
 * ⚠️ AND NOT ONE OF THESE MESSAGES NAMES A SERVICE, A PATIENT OR A DIAGNOSIS
 * (BI-007, SC-026). The name of a service can be as revealing as a diagnosis
 * once it reaches a log, even though on an invoice it is obligatory.
 */
const EXPECTED: readonly [
  new (...args: never[]) => DomainError,
  string,
  unknown,
][] = [
  // prettier-ignore
  [errors.BillableServiceNotFoundError, 'BILLABLE_SERVICE_NOT_FOUND', NotFoundError], // prettier-ignore
  [errors.BillableServiceInUseError, 'BILLABLE_SERVICE_IN_USE', ConflictError],
  [errors.BillableServiceInactiveError, 'BILLABLE_SERVICE_INACTIVE', BusinessRuleViolation], // prettier-ignore
  [errors.InvoiceChargesChangedError, 'INVOICE_CHARGES_CHANGED', ConflictError],
  [errors.ServiceCategoryNotFoundError, 'SERVICE_CATEGORY_NOT_FOUND', NotFoundError], // prettier-ignore
  [errors.ServiceCategoryInactiveError, 'SERVICE_CATEGORY_INACTIVE', BusinessRuleViolation], // prettier-ignore
  [errors.ServiceKindMismatchError, 'SERVICE_KIND_MISMATCH', BusinessRuleViolation], // prettier-ignore
  [errors.ServiceNamedElsewhereError, 'SERVICE_NAMED_ELSEWHERE', ConflictError], // prettier-ignore
  // BI-256, BI-257 (D-159).
  [errors.ServiceNotAProcedureError, 'SERVICE_NOT_A_PROCEDURE', BusinessRuleViolation], // prettier-ignore
  [errors.ServiceProcedureNotInTariffError, 'SERVICE_PROCEDURE_NOT_IN_TARIFF', BusinessRuleViolation], // prettier-ignore
  [errors.ServiceConsentTieLockedError, 'SERVICE_CONSENT_TIE_LOCKED', ConflictError], // prettier-ignore
  [errors.ServiceProcedureTakenError, 'SERVICE_PROCEDURE_TAKEN', ConflictError], // prettier-ignore
  [errors.ServiceTariffCodeFromProcedureError, 'SERVICE_TARIFF_CODE_FROM_PROCEDURE', ConflictError], // prettier-ignore
  [errors.ServiceTariffCodeInvoicedError, 'SERVICE_TARIFF_CODE_INVOICED', ConflictError], // prettier-ignore
  [errors.TaxRateRequiredError, 'TAX_RATE_REQUIRED', ValidationError],
  [errors.TaxRateNotFoundError, 'TAX_RATE_NOT_FOUND', NotFoundError],
  [errors.TaxRateInUseError, 'TAX_RATE_IN_USE', ConflictError],
  [errors.TaxReviewRateChangedError, 'TAX_REVIEW_RATE_CHANGED', ConflictError],
  [errors.PayerNotFoundError, 'PAYER_NOT_FOUND', NotFoundError],
  [errors.PayerInactiveError, 'PAYER_INACTIVE', BusinessRuleViolation],
  [errors.PayerInUseError, 'PAYER_IN_USE', ConflictError],
  [errors.LastActivePayerError, 'LAST_ACTIVE_PAYER', ConflictError],
  // BI-100, BI-141, BI-144, BI-146.
  [errors.PaymentMethodNotFoundError, 'PAYMENT_METHOD_NOT_FOUND', NotFoundError], // prettier-ignore
  [errors.PaymentMethodNameTakenError, 'PAYMENT_METHOD_NAME_TAKEN', ConflictError], // prettier-ignore
  [errors.LastActivePaymentMethodError, 'LAST_ACTIVE_PAYMENT_METHOD', ConflictError], // prettier-ignore
  [errors.DiscountLimitRoleNotFoundError, 'DISCOUNT_LIMIT_ROLE_NOT_FOUND', NotFoundError], // prettier-ignore
  // B6: BI-101, BI-102, BI-104, BI-247, BI-248, BI-251, BI-252.
  [errors.PaymentExceedsBalanceError, 'PAYMENT_EXCEEDS_BALANCE', BusinessRuleViolation], // prettier-ignore
  [errors.CashSessionClosedError, 'CASH_SESSION_CLOSED', ConflictError],
  [errors.CashSessionAlreadyClosedError, 'CASH_SESSION_ALREADY_CLOSED', ConflictError], // prettier-ignore
  [errors.CashSessionChangedError, 'CASH_SESSION_CHANGED', ConflictError],
  [errors.CashSessionEmptyError, 'CASH_SESSION_EMPTY', BusinessRuleViolation],
  [errors.PaymentNotFoundError, 'PAYMENT_NOT_FOUND', NotFoundError],
  [errors.PaymentAlreadyReversedError, 'PAYMENT_ALREADY_REVERSED', ConflictError], // prettier-ignore
  [errors.PaymentMethodInactiveError, 'PAYMENT_METHOD_INACTIVE', BusinessRuleViolation], // prettier-ignore
  [errors.PaymentMethodMismatchError, 'PAYMENT_METHOD_MISMATCH', BusinessRuleViolation], // prettier-ignore
  [errors.InvoiceNotPayableError, 'INVOICE_NOT_PAYABLE', ConflictError],
  [errors.PayerRucRequiredError, 'PAYER_RUC_REQUIRED', ValidationError],
  [errors.PriceListNotFoundError, 'PRICE_LIST_NOT_FOUND', NotFoundError],
  [errors.PricePeriodInvalidError, 'PRICE_PERIOD_INVALID', ValidationError],
  [errors.TariffPublicationNotFoundError, 'TARIFF_PUBLICATION_NOT_FOUND', NotFoundError], // prettier-ignore
  [errors.TariffPublicationEmptyError, 'TARIFF_PUBLICATION_EMPTY', ConflictError], // prettier-ignore
  [errors.PriceNegativeAmountError, 'PRICE_NEGATIVE_AMOUNT', ValidationError],
  [errors.PriceNotEditableError, 'PRICE_NOT_EDITABLE', ValidationError],
  [errors.PriceEntryNotFoundError, 'PRICE_ENTRY_NOT_FOUND', NotFoundError],
  [errors.AccountNotFoundError, 'ACCOUNT_NOT_FOUND', NotFoundError],
  [errors.AccountClosedError, 'ACCOUNT_CLOSED', ConflictError],
  [errors.AccountHasBilledChargesError, 'ACCOUNT_HAS_BILLED_CHARGES', ConflictError], // prettier-ignore
  [errors.ChargeNotRemovedError, 'CHARGE_NOT_REMOVED', ConflictError],
  [errors.ChargeHasAmountError, 'CHARGE_HAS_AMOUNT', ConflictError],
  [errors.InvalidChargeQuantityError, 'INVALID_CHARGE_QUANTITY', ValidationError], // prettier-ignore
  [errors.InvoiceNotFoundError, 'INVOICE_NOT_FOUND', NotFoundError],
  [
    errors.InvoiceHasNoItemsError,
    'INVOICE_HAS_NO_ITEMS',
    BusinessRuleViolation,
  ],
  [errors.EmissionPointInactiveError, 'EMISSION_POINT_INACTIVE', BusinessRuleViolation], // prettier-ignore
  [errors.InvoiceReceiverIsPayerError, 'INVOICE_RECEIVER_IS_PAYER', BusinessRuleViolation], // prettier-ignore
];

describe('el contrato de los errores de facturación', () => {
  for (const [Error_, code, category] of EXPECTED) {
    it(`BI-007 ${code} lleva su categoría y no nombra a nadie`, () => {
      const error = new Error_();

      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(category);
      // The technical message feeds the logs and is never exposed; what the
      // user reads is `userTitle` and `errors[]`. Neither may carry a name.
      expect(`${error.message} ${error.userTitle ?? ''}`).not.toMatch(
        /Consulta de|Guamán|paciente María/,
      );
    });
  }

  it('BI-047 PRICE_NOT_FOUND nombra prestación, pagador y fecha, y nada más', () => {
    // The three facts are the requirement and not a courtesy: whoever is at
    // the cashier has to tell «falta el precio» from «el pagador no es el que
    // toca» from «la fecha se tecleó mal».
    const error = new errors.PriceNotFoundError(
      'service-1',
      'payer-1',
      parseClinicalDate('2026-05-11'),
    );

    expect(error.code).toBe('PRICE_NOT_FOUND');
    expect(error.params).toEqual({
      billableServiceId: 'service-1',
      payerId: 'payer-1',
      serviceDate: '2026-05-11',
    });
    // IDENTIFIERS, never names: `params` reaches the HTTP response.
    expect(error.fieldErrors?.[0]?.field).toBe('serviceDate');
  });

  it('BI-072 ACCOUNT_HAS_OPEN_CHARGES enumera los cargos por identificador', () => {
    const error = new errors.AccountHasOpenChargesError(['a', 'b']);

    expect(error.openChargeIds).toEqual(['a', 'b']);
    // The COUNT travels in the params, not the list: a body that grows with
    // the account is a body somebody logs whole.
    expect(error.params).toEqual({ openCharges: 2 });
  });

  it('BI-237 ACCOUNT_NO_CHARGE_REASON_REQUIRED es 422 y señala el motivo', () => {
    const error = new errors.AccountNoChargeReasonRequiredError();
    expect(error.code).toBe('ACCOUNT_NO_CHARGE_REASON_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toContain('por qué no se cobra');
    expect(error.fieldErrors?.[0]?.field).toBe('noChargeReason');
  });

  it('BI-080 INVOICE_RECEIVER_REQUIRED señala el campo que falta', () => {
    const error = new errors.InvoiceReceiverRequiredError('receiver.name');
    expect(error.fieldErrors?.[0]?.field).toBe('receiver.name');
  });

  it('BI-081 FINAL_CONSUMER_NOT_CONFIRMED explica lo que se pierde al emitir así', () => {
    const error = new errors.FinalConsumerNotConfirmedError(
      'receiver.finalConsumer.reason',
    );

    expect(error.code).toBe('FINAL_CONSUMER_NOT_CONFIRMED');
    // The sentence has to say WHY it is expensive: the rebate is destroyed and
    // since 2026 the invoice cannot even be voided.
    expect(error.userTitle).toMatch(/gastos personales/);
  });

  it('BI-084 INVOICE_IMMUTABLE es un conflicto y nombra la nota de crédito', () => {
    const error = new errors.InvoiceImmutableError('for the log');

    expect(error).toBeInstanceOf(ConflictError);
    // Whoever reads it has no «editar factura» button to look for and never
    // will, so the message has to name the way out.
    expect(error.userTitle).toMatch(/nota de crédito/);
  });

  it('BI-007 declara en el catálogo público todos los códigos de este módulo', () => {
    // `error-catalogue.spec.ts` already fails if the two diverge; this says it
    // from the module's side, so a code added here without touching the
    // catalogue fails in the file where it was added.
    for (const [, code] of EXPECTED) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
    for (const code of [
      'PRICE_NOT_FOUND',
      'ACCOUNT_HAS_OPEN_CHARGES',
      'INVOICE_RECEIVER_REQUIRED',
      'FINAL_CONSUMER_NOT_CONFIRMED',
      'INVOICE_IMMUTABLE',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});

describe('BI-171 el código de prestación que el SRI no acepta', () => {
  it('BI-171 INVOICE_SERVICE_CODE_TOO_LONG es una regla de negocio (422) y nombra la prestación y su código', () => {
    const error = new errors.InvoiceServiceCodeTooLongError(
      'Aplicación de toxina botulínica con fin estético',
      'PROC-ESTETICA-TOXINA-BOTULINICA',
    );
    expect(error.code).toBe('INVOICE_SERVICE_CODE_TOO_LONG');
    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error.userTitle).toContain(
      '«Aplicación de toxina botulínica con fin estético»',
    );
    expect(error.userTitle).toContain('PROC-ESTETICA-TOXINA-BOTULINICA');
    expect(error.userTitle).toContain('25 caracteres');
  });
});

describe('BI-091 a BI-097, BI-208 a BI-216 corregir una factura: los errores', () => {
  const CASES: readonly [string, () => DomainError, string, unknown][] = [
    ['BI-209', () => new errors.CreditNoteReasonRequiredError(), 'CREDIT_NOTE_REASON_REQUIRED', ValidationError], // prettier-ignore
    ['BI-094', () => new errors.CreditNoteWindowExpiredError(clinicalDateOf(new Date())), 'CREDIT_NOTE_WINDOW_EXPIRED', ConflictError], // prettier-ignore
    ['BI-095', () => new errors.CreditNoteExceedsInvoiceError(), 'CREDIT_NOTE_EXCEEDS_INVOICE', BusinessRuleViolation], // prettier-ignore
    ['BI-097', () => new errors.CreditNoteInvoiceVoidedError(), 'CREDIT_NOTE_INVOICE_VOIDED', ConflictError], // prettier-ignore
    ['BI-208', () => new errors.CreditNoteInvoiceNotAuthorisedError(), 'CREDIT_NOTE_INVOICE_NOT_AUTHORISED', ConflictError], // prettier-ignore
    ['BI-211', () => new errors.CreditNoteLineNotInInvoiceError(), 'CREDIT_NOTE_LINE_NOT_IN_INVOICE', BusinessRuleViolation], // prettier-ignore
    ['BI-211', () => new errors.CreditNoteLineAlreadyCreditedError(), 'CREDIT_NOTE_LINE_ALREADY_CREDITED', ConflictError], // prettier-ignore
    ['BI-213', () => new errors.CreditNoteFinalConsumerError(), 'CREDIT_NOTE_FINAL_CONSUMER', ConflictError], // prettier-ignore
    ['BI-216', () => new errors.InvoiceNotEditableError(), 'INVOICE_NOT_EDITABLE', ConflictError], // prettier-ignore
  ];

  for (const [requirement, make, code, category] of CASES) {
    it(`${requirement} ${code} lleva su categoría, está en el catálogo y dice qué hacer`, () => {
      const error = make();
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(category);
      expect(DOMAIN_ERROR_CODES).toContain(code);
      expect(error.userTitle).toBeTruthy();
    });
  }

  it('BI-209 CREDIT_NOTE_REASON_REQUIRED señala el campo del texto de «Otro»', () => {
    const error = new errors.CreditNoteReasonRequiredError();
    expect(error.fieldErrors?.[0]?.field).toBe('reasonText');
  });

  it('BI-213 CREDIT_NOTE_FINAL_CONSUMER dice lo que la pantalla dice junto a la fila', () => {
    expect(new errors.CreditNoteFinalConsumerError().userTitle).toBe(
      'Consumidor Final: no admite nota de crédito',
    );
  });
});
