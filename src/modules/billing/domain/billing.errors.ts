import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

/**
 * What can go wrong when charging for care, in business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`,
 * which is what lets these rules run from a nightly re-billing job as well as
 * from a cashier's screen.
 *
 * ⚠️ NOTHING IN A MESSAGE NAMES A SERVICE, A DIAGNOSIS OR A PATIENT (BI-007,
 * SC-026). «Consulta de dermatología» on an invoice is obligatory; the same
 * words in an error body that reaches a log are a diagnosis in all but name.
 * Identifiers travel in `params` when the caller needs to act on them; the
 * NAME never does.
 *
 * NOT DECLARED HERE, on purpose: the codes produced by PostgreSQL constraints
 * (`PRICE_PERIOD_OVERLAP`, `PRICE_PERIOD_EMPTY`, `INVOICE_TOTAL_INCONSISTENT`,
 * …). They live in `infrastructure/billing.constraints.ts`, which is their
 * enumeration. Restating them here would be a second, weaker copy of a rule
 * the database already guarantees.
 */

// ───────────────────────────────────────────────────────────────────────────
// The catalogue of services (BI-010 to BI-016)
// ───────────────────────────────────────────────────────────────────────────

/** BI-010, BI-135. */
export class BillableServiceNotFoundError extends NotFoundError {
  readonly code = 'BILLABLE_SERVICE_NOT_FOUND';
  override readonly userTitle = 'Esa prestación no existe o ya no está disponible'; // prettier-ignore

  constructor() {
    super('No billable service with that identifier');
  }
}

/**
 * BI-012. A service a charge already names is never deleted, it is deactivated.
 *
 * It is contable before it is technical: the service an eight-month-old
 * invoice names has to keep existing for that invoice to be readable at all.
 */
export class BillableServiceInUseError extends ConflictError {
  readonly code = 'BILLABLE_SERVICE_IN_USE';
  override readonly userTitle =
    'Esa prestación ya se usó en cargos o precios: desactívela en lugar de borrarla';

  constructor() {
    super('Billable service is referenced by prices or charges');
  }
}

/** BI-185, BI-135. */
export class ServiceCategoryNotFoundError extends NotFoundError {
  readonly code = 'SERVICE_CATEGORY_NOT_FOUND';
  override readonly userTitle = 'Esa categoría no existe o ya no está disponible'; // prettier-ignore

  constructor() {
    super('No service category with that identifier');
  }
}

/**
 * BI-185. A deactivated category is no longer offered: the services that
 * already carry it keep it, new ones cannot take it.
 */
export class ServiceCategoryInactiveError extends BusinessRuleViolation {
  readonly code = 'SERVICE_CATEGORY_INACTIVE';
  override readonly userTitle =
    'Esa categoría está desactivada: elija otra o vuelva a activarla';

  constructor() {
    super('Service category is inactive', {}, [
      {
        field: 'categoryId',
        code: 'SERVICE_CATEGORY_INACTIVE',
        message: 'Seleccione una categoría activa',
      },
    ]);
  }
}

/**
 * BI-187. The category's kind says what structure the service admits: only a
 * consultation is the consultation of a specialty (BI-158), and a service tied
 * to one — or to a procedure — cannot move to a category of another kind.
 */
export class ServiceKindMismatchError extends BusinessRuleViolation {
  readonly code = 'SERVICE_KIND_MISMATCH';
  override readonly userTitle =
    'Esa clase no admite lo que la prestación ya tiene atado (una especialidad, un procedimiento o exámenes)';

  constructor() {
    super('Service category kind does not admit that structure', {}, [
      {
        field: 'categoryId',
        code: 'SERVICE_KIND_MISMATCH',
        message: 'Elija una categoría de la clase que corresponde',
      },
    ]);
  }
}

/** BI-015. */
export class BillableServiceInactiveError extends BusinessRuleViolation {
  readonly code = 'BILLABLE_SERVICE_INACTIVE';
  override readonly userTitle =
    'Esa prestación está desactivada y no se puede cobrar: elija otra o vuelva a activarla';

  constructor() {
    super('Billable service is inactive and cannot be charged', {}, [
      {
        field: 'billableServiceId',
        code: 'BILLABLE_SERVICE_INACTIVE',
        message: 'Seleccione una prestación activa',
      },
    ]);
  }
}

/**
 * BI-013. The rate is demanded by the SERVICE, not by the DTO.
 *
 * A requirement enforced only at the transport layer stops existing the moment
 * a seed or a bulk import writes underneath it — the same reasoning that moved
 * `CANCELLATION_REASON_REQUIRED` into the service in `agenda`.
 */
export class TaxRateRequiredError extends ValidationError {
  readonly code = 'TAX_RATE_REQUIRED';
  override readonly userTitle =
    'Indique la tarifa de impuesto de la prestación: el sistema no la deduce';

  constructor() {
    super('A billable service must carry a tax rate', {}, [
      {
        field: 'taxRateId',
        code: 'TAX_RATE_REQUIRED',
        message: 'Seleccione la tarifa de impuesto que aplica',
      },
    ]);
  }
}

/** BI-020. */
export class TaxRateNotFoundError extends NotFoundError {
  readonly code = 'TAX_RATE_NOT_FOUND';
  override readonly userTitle = 'Esa tarifa de impuesto no existe';

  constructor() {
    super('No tax rate with that identifier');
  }
}

/** BI-026. */
export class TaxRateInUseError extends ConflictError {
  readonly code = 'TAX_RATE_IN_USE';
  override readonly userTitle =
    'Esa tarifa la usan prestaciones del catálogo: cámbieselas antes de retirarla';

  constructor() {
    super('Tax rate is referenced by billable services');
  }
}

/**
 * BI-024 (D-172). The review names the rate its author SAW: if the rate
 * changed in between —another tab, another administrator—, marking it would
 * sign a rate nobody looked at.
 */
export class TaxReviewRateChangedError extends ConflictError {
  readonly code = 'TAX_REVIEW_RATE_CHANGED';
  override readonly userTitle =
    'La tarifa de esta prestación cambió mientras la revisaba: vuelva a mirarla antes de marcarla revisada';

  constructor() {
    super('The tax rate is no longer the one the reviewer saw');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Payers (BI-030 to BI-035)
// ───────────────────────────────────────────────────────────────────────────

/** BI-030, BI-135. */
export class PayerNotFoundError extends NotFoundError {
  readonly code = 'PAYER_NOT_FOUND';
  override readonly userTitle = 'Ese pagador no existe';

  constructor() {
    super('No payer with that identifier');
  }
}

/** BI-030. */
export class PayerInactiveError extends BusinessRuleViolation {
  readonly code = 'PAYER_INACTIVE';
  override readonly userTitle =
    'Ese pagador está desactivado: elija otro para abrir la cuenta';

  constructor() {
    super('Payer is inactive', {}, [
      {
        field: 'payerId',
        code: 'PAYER_INACTIVE',
        message: 'Seleccione un pagador activo',
      },
    ]);
  }
}

/** BI-032. */
export class PayerInUseError extends ConflictError {
  readonly code = 'PAYER_IN_USE';
  override readonly userTitle =
    'Ese pagador ya tiene cuentas o listas de precios: desactívelo en lugar de borrarlo';

  constructor() {
    super('Payer is referenced by price lists or accounts');
  }
}

/**
 * BI-031. The last active payer is not deactivated.
 *
 * An installation with no active payer is a clinic that cannot open a single
 * account, and the failure would show up at the desk rather than on the screen
 * where somebody flipped the switch.
 */
export class LastActivePayerError extends ConflictError {
  readonly code = 'LAST_ACTIVE_PAYER';
  override readonly userTitle =
    'Es el único pagador activo: active otro antes de desactivar éste';

  constructor() {
    super('Refusing to deactivate the only active payer');
  }
}

/**
 * BI-034. The one branch this module takes on `payer.kind`, and it is a
 * validation: a company agreement with no RUC cannot be invoiced.
 *
 * The check digit itself is `Ruc` in `shared` (OR-008), which answers
 * `INVALID_RUC`. This one is the absence, which is a different thing to fix.
 */
export class PayerRucRequiredError extends ValidationError {
  readonly code = 'PAYER_RUC_REQUIRED';
  override readonly userTitle =
    'Un pagador institucional necesita RUC para poder recibir factura';

  constructor() {
    super('An institutional payer must carry a RUC', {}, [
      {
        field: 'ruc',
        code: 'PAYER_RUC_REQUIRED',
        message: 'Indique el RUC del pagador institucional',
      },
    ]);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Price lists (BI-040 to BI-048)
// ───────────────────────────────────────────────────────────────────────────

/** BI-230. The price row named in the route does not exist. */
export class PriceEntryNotFoundError extends NotFoundError {
  readonly code = 'PRICE_ENTRY_NOT_FOUND';
  override readonly userTitle =
    'Ese precio no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Price entry not found');
  }
}

/** BI-040. */
export class PriceListNotFoundError extends NotFoundError {
  readonly code = 'PRICE_LIST_NOT_FOUND';
  override readonly userTitle =
    'Ese pagador todavía no tiene lista de precios: créela antes de cobrarle';

  constructor() {
    super('No price list for that payer');
  }
}

/** BI-041. */
export class PricePeriodInvalidError extends ValidationError {
  readonly code = 'PRICE_PERIOD_INVALID';
  override readonly userTitle =
    'La fecha de fin de la vigencia tiene que ser posterior a la de inicio';

  constructor() {
    super('Price validity must be a non-empty half-open period', {}, [
      {
        field: 'validTo',
        code: 'PRICE_PERIOD_INVALID',
        message: 'Indique una fecha posterior a la de inicio, o déjela vacía',
      },
    ]);
  }
}

/**
 * BI-230. A price whose validity ended before today is history: what it
 * justified is already frozen in its charges, and the way to change what a
 * service costs from now on is a new price (BI-044).
 */
export class PriceNotEditableError extends ValidationError {
  readonly code = 'PRICE_NOT_EDITABLE';
  override readonly userTitle =
    'Ese precio ya no rige: para cambiar lo que cuesta, fije un precio nuevo';

  constructor() {
    super('A price whose validity already ended cannot be corrected', {}, [
      {
        field: 'amount',
        code: 'PRICE_NOT_EDITABLE',
        message: 'Sólo se corrige un precio vigente o futuro',
      },
    ]);
  }
}

/** BI-043. Zero is a real price; below zero is not. */
export class PriceNegativeAmountError extends ValidationError {
  readonly code = 'PRICE_NEGATIVE_AMOUNT';
  override readonly userTitle =
    'El precio no puede ser negativo. Cero sí es un precio válido';

  constructor() {
    super('A price cannot be negative', {}, [
      {
        field: 'amount',
        code: 'PRICE_NEGATIVE_AMOUNT',
        message: 'Indique un importe de cero o mayor',
      },
    ]);
  }
}

/**
 * BI-047. No price in force for that service, that payer and that date.
 *
 * THE THREE FACTS TRAVEL IN THE ERROR, and that is the requirement rather than
 * a courtesy: whoever is at the cashier has to be able to tell «falta el
 * precio» from «el pagador no es el que toca» from «la fecha del servicio se
 * tecleó mal», and an error that does not distinguish them sends somebody to
 * look in the wrong place.
 *
 * Identifiers, never names: the name of a service is as revealing as a
 * diagnosis once it reaches a log (BI-007).
 */
export class PriceNotFoundError extends BusinessRuleViolation {
  readonly code = 'PRICE_NOT_FOUND';
  override readonly userTitle =
    'No hay precio vigente para esa prestación, ese pagador y esa fecha de servicio';

  constructor(
    billableServiceId: string,
    payerId: string,
    serviceDate: ClinicalDate,
  ) {
    super(
      'No price in force for that service, payer and service date',
      { billableServiceId, payerId, serviceDate },
      [
        {
          field: 'serviceDate',
          code: 'PRICE_NOT_FOUND',
          message:
            'Compruebe la fecha del servicio y el pagador de la cuenta, o fije el precio de esa prestación',
        },
      ],
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The account (BI-070 to BI-074) and the charge (BI-050 to BI-059)
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-135. An account of another site answers exactly like one that does not
 * exist: distinguishing them confirms other sites' accounts to whoever guesses
 * identifiers, and an account confirms that a patient was here.
 */
export class AccountNotFoundError extends NotFoundError {
  readonly code = 'ACCOUNT_NOT_FOUND';
  override readonly userTitle = 'Esa cuenta no existe';

  constructor() {
    super('No account with that identifier in this site');
  }
}

/** BI-071. */
export class AccountClosedError extends ConflictError {
  readonly code = 'ACCOUNT_CLOSED';
  override readonly userTitle =
    'Esa cuenta ya está cerrada: no admite cargos nuevos ni cambios';

  constructor() {
    super('Account is closed');
  }
}

/**
 * BI-198 (replaces BI-033's `ACCOUNT_HAS_CHARGES`). The open lines are
 * repriced with the new payer; a BILLED one cannot be — changing what an
 * issued invoice charged is correcting that invoice (CA-8), not this route.
 */
export class AccountHasBilledChargesError extends ConflictError {
  readonly code = 'ACCOUNT_HAS_BILLED_CHARGES';
  override readonly userTitle =
    'La cuenta ya tiene cargos facturados con el pagador actual: el pagador no se cambia';

  constructor() {
    super('Account already holds billed charges');
  }
}

/** BI-072. The charges are ENUMERATED, so somebody can act on them. */
export class AccountHasOpenChargesError extends ConflictError {
  readonly code = 'ACCOUNT_HAS_OPEN_CHARGES';
  override readonly userTitle =
    'La cuenta tiene cargos sin facturar ni anular: resuélvalos antes de cerrarla';

  constructor(readonly openChargeIds: readonly string[]) {
    super('Account still holds charges that are neither billed nor voided', {
      openCharges: openChargeIds.length,
    });
  }
}

/**
 * BI-057. The database admits three decimals (`charge_item.quantity` is
 * `numeric(10,3)`, and `charge_item_quantity_is_positive` is the guarantee);
 * what neither admits is zero or less.
 */
export class InvalidChargeQuantityError extends ValidationError {
  readonly code = 'INVALID_CHARGE_QUANTITY';
  override readonly userTitle = 'La cantidad del cargo tiene que ser mayor que cero'; // prettier-ignore

  constructor() {
    super('Charge quantity must be greater than zero', {}, [
      {
        field: 'quantity',
        code: 'INVALID_CHARGE_QUANTITY',
        message: 'Indique una cantidad mayor que cero',
      },
    ]);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// From the clinical act to the charge (BI-150 to BI-158)
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-150, BI-135. The visit does not exist, or belongs to another site.
 *
 * ⚠️ NOT `ENCOUNTER_NOT_FOUND`, which is the clinical module's. The two say
 * the same words and answer different questions, and a client that could not
 * tell them apart would show «esa atención no existe» from a cashier screen
 * for a visit that exists and is simply not this site's — exactly the
 * distinction `ORDER_ENCOUNTER_NOT_FOUND` already makes for orders.
 *
 * AND IT DOES NOT DISTINGUISH «no existe» FROM «es de otra sede», like every
 * refusal in this module: a visit confirms that a person was at a clinic.
 */
export class BillingEncounterNotFoundError extends NotFoundError {
  readonly code = 'BILLING_ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'Esa atención no existe en esta sede o no está disponible';

  constructor() {
    super('No encounter with that identifier in this site');
  }
}

/**
 * BI-150. Opening the account of a visit needs to know WHO PAYS.
 *
 * ⚠️ AND THIS REFUSAL IS NOT A GATE ON CARE (Ley 77 art. 9, BI-003, BI-120).
 * Nothing clinical calls this route: the visit was received, treated and
 * discharged before anybody pressed «enviar a caja». What is refused here is
 * opening an ACCOUNT with no payer — `patient_account.payer_id` is NOT NULL
 * because the payer is what decides the price of everything that already
 * happened (BI-121) — and the answer is to ask at the counter, not to send a
 * patient away.
 */
export class PayerRequiredToOpenAccountError extends ValidationError {
  readonly code = 'PAYER_REQUIRED_TO_OPEN_ACCOUNT';
  override readonly userTitle =
    'Esa atención todavía no tiene cuenta: indique quién paga para abrirla';

  constructor() {
    super('Opening the account of an encounter requires a payer', {}, [
      {
        field: 'payerId',
        code: 'PAYER_REQUIRED_TO_OPEN_ACCOUNT',
        message: 'Indique quién paga',
      },
    ]);
  }
}

/**
 * BI-154. That clinical act already has a charge.
 *
 * ⚠️ RAISED BY THE DATABASE, NOT BY A CHECK IN A SERVICE. The three partial
 * unique indexes — `charge_item_one_per_encounter_procedure`,
 * `charge_item_one_per_service_order_item` and
 * `charge_item_one_consultation_per_encounter` — are what makes «pressing twice
 * does not duplicate» true under two cashiers pressing at the same second; a
 * read before the write leaves both of them seeing nothing charged.
 *
 * The checkout catches this and reports the line as `ALREADY_CHARGED` instead
 * of failing: a race that resolves itself correctly is not an incident.
 */
export class ActAlreadyChargedError extends ConflictError {
  readonly code = 'ACT_ALREADY_CHARGED';
  override readonly userTitle =
    'Ese acto de la atención ya tiene un cargo en esta cuenta';

  constructor() {
    super('The clinical act already has a charge');
  }
}

/** BI-055, BI-135. Same silence as every other read of this module. */
export class ChargeNotFoundError extends NotFoundError {
  readonly code = 'CHARGE_NOT_FOUND';
  override readonly userTitle = 'Ese cargo no existe en esta cuenta';

  constructor() {
    super('No charge with that identifier on that account');
  }
}

/**
 * BI-056. THE ERROR NAMES THE WAY OUT, and that is the whole point of it.
 *
 * A 409 that only says «ya facturado» leaves whoever is at the counter looking
 * for an «editar factura» button that does not exist and is never going to
 * (BI-090, D-A-007). Correcting an issued invoice is a credit note: another
 * act, another permission, a mandatory reason.
 */
export class ChargeAlreadyInvoicedError extends ConflictError {
  readonly code = 'CHARGE_ITEM_ALREADY_INVOICED';
  override readonly userTitle =
    'Ese cargo ya está en una factura emitida: para corregirlo se emite una nota de crédito';

  constructor() {
    super('Charge belongs to an issued invoice and cannot be changed');
  }
}

/**
 * BI-059. A voided charge does not come back.
 *
 * Reactivating one would leave an account whose total changed with nothing to
 * explain it. What is done instead is to raise a new charge, which is born
 * with its own date and its own author.
 */
export class ChargeAlreadyVoidedError extends ConflictError {
  readonly code = 'CHARGE_ALREADY_VOIDED';
  override readonly userTitle =
    'Ese cargo ya se quitó: use «Deshacer» si hay que cobrarlo';

  constructor() {
    super('The charge was already removed');
  }
}

/** BI-195. «Deshacer» only puts back a line that was removed. */
export class ChargeNotRemovedError extends ConflictError {
  readonly code = 'CHARGE_NOT_REMOVED';
  override readonly userTitle =
    'Ese cargo no está quitado ni marcado «No se cobra»: no hay nada que deshacer';

  constructor() {
    super('Only a removed or not-billable charge is restored');
  }
}

/**
 * BI-196. «No se cobra» is for the $0 line (D-120). A line with an amount
 * that is not charged is REMOVED (BI-195), which says so in the account.
 */
export class ChargeHasAmountError extends ConflictError {
  readonly code = 'CHARGE_HAS_AMOUNT';
  override readonly userTitle =
    'Solo un cargo de $0 se marca «No se cobra»: si este no se cobra, quítelo';

  constructor() {
    super('Only a zero-amount charge is marked not billable');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The invoice (BI-080 to BI-090)
// ───────────────────────────────────────────────────────────────────────────

/** BI-135. Same silence as `ACCOUNT_NOT_FOUND`, and for the same reason. */
export class InvoiceNotFoundError extends NotFoundError {
  readonly code = 'INVOICE_NOT_FOUND';
  override readonly userTitle = 'Esa factura no existe';

  constructor() {
    super('No invoice with that identifier in this site');
  }
}

/** BI-080. The field is named so the screen can point at it. */
export class InvoiceReceiverRequiredError extends ValidationError {
  readonly code = 'INVOICE_RECEIVER_REQUIRED';
  override readonly userTitle =
    'Indique a nombre de quién se emite la factura: tipo y número de identificación, y nombre';

  constructor(field: string) {
    super('The invoice receiver is incomplete', { field }, [
      {
        field,
        code: 'INVOICE_RECEIVER_REQUIRED',
        message: 'Complete los datos de quien recibe la factura',
      },
    ]);
  }
}

/**
 * BI-081. «Consumidor final» is an explicit exception, never a default.
 *
 * ⚠️ THE CONFIRMATION IS THE SERVER'S, NOT A DIALOG'S. A warning that lives
 * only on the screen disappears the moment somebody calls this route from
 * somewhere else — and this is precisely the route a cashier shortcut calls.
 *
 * Why it costs so much: issuing this way destroys the patient's
 * personal-expense rebate and, since 2026, the invoice cannot even be voided
 * (D-A-007, BI-093). It is the definition of an expensive default: comfortable
 * for whoever types, irreversible for whoever pays.
 */
export class FinalConsumerNotConfirmedError extends ValidationError {
  readonly code = 'FINAL_CONSUMER_NOT_CONFIRMED';
  override readonly userTitle =
    'Emitir a Consumidor Final quita al paciente la rebaja de gastos personales: confírmelo';

  constructor(field: string) {
    super('Final-consumer issuance needs an explicit confirmation', { field }, [
      // prettier-ignore
      {
        field,
        code: 'FINAL_CONSUMER_NOT_CONFIRMED',
        message:
          'Confirme expresamente la emisión a Consumidor Final',
      },
    ]);
  }
}

/**
 * BI-184. Between the cashier reading the total and pressing «emitir», the
 * pending charges changed — another cashier confirmed, added or removed one.
 * The invoice is a tax document that cannot be edited afterwards (D-A-007), so
 * it is not issued for an amount nobody saw.
 */
export class InvoiceChargesChangedError extends ConflictError {
  readonly code = 'INVOICE_CHARGES_CHANGED';
  override readonly userTitle =
    'Los cargos de la cuenta cambiaron mientras se emitía: revise el total y vuelva a emitir';

  constructor() {
    super('Pending charges differ from the ones the cashier saw');
  }
}

/** BI-089. */
export class InvoiceHasNoItemsError extends BusinessRuleViolation {
  readonly code = 'INVOICE_HAS_NO_ITEMS';
  override readonly userTitle =
    'Esa cuenta no tiene cargos pendientes de facturar';

  constructor() {
    super('Refusing to issue an invoice with no lines');
  }
}

/**
 * BI-171. A charge's service has a catalogue code longer than the voucher's
 * `codigoPrincipal` admits (25, mandatory in the Ficha): issuing would hand
 * the SRI an XML it returns with error 35, after the sequential is spent.
 */
export class InvoiceServiceCodeTooLongError extends BusinessRuleViolation {
  readonly code = 'INVOICE_SERVICE_CODE_TOO_LONG';
  override readonly userTitle: string;

  constructor(serviceName: string, serviceCode: string) {
    super('Refusing to issue: a service code exceeds the SRI limit', {
      serviceName,
      serviceCode,
    });
    this.userTitle = `La prestación «${serviceName}» tiene el código ${serviceCode}, más largo de los 25 caracteres que acepta el SRI. Administración debe acortarlo en el catálogo antes de facturarla`;
  }
}

/** BI-085. */
export class EmissionPointInactiveError extends BusinessRuleViolation {
  readonly code = 'EMISSION_POINT_INACTIVE';
  override readonly userTitle =
    'Ese punto de emisión está desactivado: elija otro para facturar';

  constructor() {
    super('Emission point is inactive', {}, [
      {
        field: 'emissionPointId',
        code: 'EMISSION_POINT_INACTIVE',
        message: 'Seleccione un punto de emisión activo',
      },
    ]);
  }
}

/**
 * BI-084, BI-090. The database refused to change an authorised invoice.
 *
 * ⚠️ REACHING THIS IS NOT A USER MISTAKE, IT IS A DEFECT — and it is declared
 * anyway. No route of this module updates an invoice (that absence IS BI-090),
 * so the only ways here are a path somebody adds later and a write from
 * outside the application. `trg_invoice_immutable` and `trg_invoice_no_delete`
 * refuse both; what this class adds is that the refusal reaches whoever is at
 * the desk as a sentence naming the way out — a credit note — instead of as
 * the 500 an untranslated PL/pgSQL exception produces.
 *
 * It is a CONFLICT and not a validation: nothing that was sent is wrong. What
 * forbids the operation is the state of the document.
 */
export class InvoiceImmutableError extends ConflictError {
  readonly code = 'INVOICE_IMMUTABLE';
  override readonly userTitle =
    'Una factura autorizada no se modifica ni se elimina: corríjala con una nota de crédito';

  constructor(technicalMessage: string) {
    super(technicalMessage);
  }
}

/**
 * BI-087, REQ-084. The invoice cannot be made out to the insurer.
 *
 * NOT IN THE SPEC'S TABLE OF CODES, and declared anyway — the same call
 * `agenda` made for `INVALID_SLOT_DURATION`. BI-087 states a prohibition with
 * no code beside it, and the two candidates were reusing
 * `INVOICE_RECEIVER_REQUIRED` — which would tell the cashier a field is
 * missing when the field is filled in and wrong — or naming what actually
 * happened. A client that has to read Spanish prose to tell «falta el dato»
 * from «ese dato es el pagador» is a client that branches on the wrong thing.
 *
 * Why it exists at all: an invoice made out to the insurer is not the
 * patient's expense, so the insurer rejects it and the reimbursement never
 * happens. The payer decides WHICH PRICE LIST applies (BI-035); it never
 * decides who appears on the document.
 */
export class InvoiceReceiverIsPayerError extends BusinessRuleViolation {
  readonly code = 'INVOICE_RECEIVER_IS_PAYER';
  override readonly userTitle =
    'La factura de un reembolso va a nombre del paciente o del titular de la póliza, nunca de la aseguradora';

  constructor() {
    super('Refusing to issue the invoice to the third-party payer', {}, [
      {
        field: 'receiver.identification',
        code: 'INVOICE_RECEIVER_IS_PAYER',
        message:
          'Indique la identificación del paciente o de quien va a deducir el gasto',
      },
    ]);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Correcting an invoice (BI-091 to BI-097, BI-208 to BI-218)
// ───────────────────────────────────────────────────────────────────────────

/** BI-091, BI-209. «Otro» without a text, or one that does not fit. */
export class CreditNoteReasonRequiredError extends ValidationError {
  readonly code = 'CREDIT_NOTE_REASON_REQUIRED';
  override readonly userTitle = 'Diga el motivo de la nota de crédito';

  constructor() {
    super('A credit note states its reason', {}, [
      {
        field: 'reasonText',
        code: 'CREDIT_NOTE_REASON_REQUIRED',
        message: 'Escriba el motivo, de hasta 300 caracteres',
      },
    ]);
  }
}

/**
 * BI-094 (Res. NAC-DGERCGC25-00000014, art. 5). Twelve months from the
 * invoice's date of issue, in Guayaquil; whether the 2025 reform removed the
 * limit is D-151.4, with the accountant.
 */
export class CreditNoteWindowExpiredError extends ConflictError {
  readonly code = 'CREDIT_NOTE_WINDOW_EXPIRED';
  override readonly userTitle =
    'Pasaron más de doce meses desde la emisión de la factura: ya no admite nota de crédito';

  constructor(readonly deadline: ClinicalDate) {
    super('The credit note window of this invoice is over', { deadline });
  }
}

/** BI-095. What was credited plus this one exceeds the invoice. */
export class CreditNoteExceedsInvoiceError extends BusinessRuleViolation {
  readonly code = 'CREDIT_NOTE_EXCEEDS_INVOICE';
  override readonly userTitle =
    'Lo acreditado no puede superar el total de la factura';

  constructor() {
    super('The credit notes of this invoice would exceed its total');
  }
}

/** BI-097. */
export class CreditNoteInvoiceVoidedError extends ConflictError {
  readonly code = 'CREDIT_NOTE_INVOICE_VOIDED';
  override readonly userTitle = 'Una factura anulada no admite nota de crédito';

  constructor() {
    super('The invoice is voided');
  }
}

/**
 * BI-208 (D-152.4). Only what the SRI authorised is corrected with a credit
 * note: a pending one waits, and a returned one is edited (BI-216).
 */
export class CreditNoteInvoiceNotAuthorisedError extends ConflictError {
  readonly code = 'CREDIT_NOTE_INVOICE_NOT_AUTHORISED';
  override readonly userTitle =
    'Solo una factura autorizada por el SRI se corrige con nota de crédito';

  constructor() {
    super('The invoice is not authorised by the SRI');
  }
}

/** BI-211. */
export class CreditNoteLineNotInInvoiceError extends BusinessRuleViolation {
  readonly code = 'CREDIT_NOTE_LINE_NOT_IN_INVOICE';
  override readonly userTitle = 'Esa línea no es de la factura que se corrige';

  constructor() {
    super('A credited charge is not a line of this invoice');
  }
}

/** BI-211. A line is credited whole and once (D-152.6). */
export class CreditNoteLineAlreadyCreditedError extends ConflictError {
  readonly code = 'CREDIT_NOTE_LINE_ALREADY_CREDITED';
  override readonly userTitle =
    'Esa línea ya se acreditó con otra nota de crédito';

  constructor() {
    super('A charge of this invoice was already credited');
  }
}

/**
 * BI-213. Res. NAC-DGERCGC25-00000014, art. 3: an invoice to «consumidor
 * final» admits no credit note (D-151.3, with the accountant).
 */
export class CreditNoteFinalConsumerError extends ConflictError {
  readonly code = 'CREDIT_NOTE_FINAL_CONSUMER';
  override readonly userTitle = 'Consumidor Final: no admite nota de crédito';

  constructor() {
    super('An invoice to the final consumer admits no credit note');
  }
}

/** BI-216. Only an invoice the SRI did not accept is corrected and resent. */
export class InvoiceNotEditableError extends ConflictError {
  readonly code = 'INVOICE_NOT_EDITABLE';
  override readonly userTitle =
    'Solo se corrige y se reenvía una factura que el SRI devolvió o no autorizó';

  constructor() {
    super('Only a returned or not authorised invoice is corrected');
  }
}

/**
 * C1 of the clinical review (D-152.7). What a credit note credited comes back
 * to the account at once, but it is billed again only once the SRI has
 * authorised the credit note: until then the service would sit on two valid
 * invoices. Usually a matter of seconds (the queue sends it on its own).
 */
export class CorrectionAwaitsCreditNoteError extends ConflictError {
  readonly code = 'CORRECTION_AWAITS_CREDIT_NOTE';
  override readonly userTitle =
    'Lo corregido se factura cuando el SRI autorice la nota de crédito: vuelva a intentarlo en unos segundos';

  constructor() {
    super('A corrected charge is billed once its credit note is authorised');
  }
}

/**
 * ORD-163, SP-030 (D-179). The service IS an exam, or is born with a service
 * type: its name (and, for an exam, its tariff code) is written there, once.
 * Changing it here would rename the exam the order freezes, without the exam
 * catalogue's trail (ORD-111), or leave it to be overwritten by the type.
 */
export class ServiceNamedElsewhereError extends ConflictError {
  readonly code = 'SERVICE_NAMED_ELSEWHERE';
  override readonly userTitle =
    'Esta prestación nace de un examen o de un tipo de atención: su nombre y su tarifario se corrigen allí';

  constructor() {
    super(
      'Service name and tariff code are owned by its exam or service type',
      {},
      [
        // prettier-ignore
        {
        field: 'name',
        code: 'SERVICE_NAMED_ELSEWHERE',
        message: 'Se corrige en Exámenes o en Especialidades',
      },
      ],
    );
  }
}
