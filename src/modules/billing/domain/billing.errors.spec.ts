import { describe, expect, it } from 'vitest';

import {
  BusinessRuleViolation,
  ConflictError,
  type DomainError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import { parseClinicalDate } from '../../../shared/domain/clinic-time';
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
  [errors.ServiceCategoryNotFoundError, 'SERVICE_CATEGORY_NOT_FOUND', NotFoundError], // prettier-ignore
  [errors.ServiceCategoryInactiveError, 'SERVICE_CATEGORY_INACTIVE', BusinessRuleViolation], // prettier-ignore
  [errors.ServiceKindMismatchError, 'SERVICE_KIND_MISMATCH', BusinessRuleViolation], // prettier-ignore
  [errors.TaxRateRequiredError, 'TAX_RATE_REQUIRED', ValidationError],
  [errors.TaxRateNotFoundError, 'TAX_RATE_NOT_FOUND', NotFoundError],
  [errors.TaxRateInUseError, 'TAX_RATE_IN_USE', ConflictError],
  [errors.PayerNotFoundError, 'PAYER_NOT_FOUND', NotFoundError],
  [errors.PayerInactiveError, 'PAYER_INACTIVE', BusinessRuleViolation],
  [errors.PayerInUseError, 'PAYER_IN_USE', ConflictError],
  [errors.LastActivePayerError, 'LAST_ACTIVE_PAYER', ConflictError],
  [errors.PayerRucRequiredError, 'PAYER_RUC_REQUIRED', ValidationError],
  [errors.PriceListNotFoundError, 'PRICE_LIST_NOT_FOUND', NotFoundError],
  [errors.PricePeriodInvalidError, 'PRICE_PERIOD_INVALID', ValidationError],
  [errors.PriceNegativeAmountError, 'PRICE_NEGATIVE_AMOUNT', ValidationError],
  [errors.AccountNotFoundError, 'ACCOUNT_NOT_FOUND', NotFoundError],
  [errors.AccountClosedError, 'ACCOUNT_CLOSED', ConflictError],
  [errors.AccountHasChargesError, 'ACCOUNT_HAS_CHARGES', ConflictError],
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
