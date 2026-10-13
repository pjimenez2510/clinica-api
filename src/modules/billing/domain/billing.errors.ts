import {
  BusinessRuleViolation,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import { SelfAuthorisationDeniedError } from '../../../shared/domain/errors/self-authorisation.error';
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
  override readonly userTitle = 'Ese servicio no existe o ya no está disponible'; // prettier-ignore

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
    'Ese servicio ya se usó en cargos, citas u órdenes: desactívelo en lugar de borrarlo';

  constructor() {
    super('Billable service is referenced by prices or charges');
  }
}

/**
 * BI-278, BI-279, BI-284. The kind of a service says what it carries: only a
 * consultation has a specialty, a duration and a visit; only an exam, an
 * imaging study or a procedure that is ordered has an order extension. And
 * the kind does not change once created.
 */
export class ServiceKindMismatchError extends BusinessRuleViolation {
  readonly code = 'SERVICE_KIND_MISMATCH';
  override readonly userTitle =
    'Ese tipo de servicio no admite esos datos: la especialidad y la duración son de una consulta, y la muestra y el ayuno de un examen';

  constructor(field = 'kind') {
    super('The service kind does not admit that structure', {}, [
      {
        field,
        code: 'SERVICE_KIND_MISMATCH',
        message: 'No corresponde a este tipo de servicio',
      },
    ]);
  }
}

/**
 * BI-279. A consultation is of an active specialty, lasts some minutes, and
 * is born with both.
 */
export class ConsultationIncompleteError extends BusinessRuleViolation {
  readonly code = 'CONSULTATION_INCOMPLETE';
  override readonly userTitle =
    'Una consulta necesita su especialidad y su duración';

  constructor(field: 'specialtyId' | 'durationMinutes') {
    super('A consultation needs its specialty and its duration', {}, [
      {
        field,
        code: 'CONSULTATION_INCOMPLETE',
        message:
          field === 'specialtyId'
            ? 'Elija una especialidad activa'
            : 'Escriba la duración en minutos',
      },
    ]);
  }
}

/**
 * BI-298 (ADR-013). One active consultation per specialty and visit: a second
 * one would leave agenda and caja guessing which is meant. The title names
 * the one that exists, so the person edits it instead.
 */
export class ConsultationDuplicateError extends ConflictError {
  readonly code = 'CONSULTATION_DUPLICATE';
  override readonly userTitle: string;

  constructor(
    specialtyName: string,
    visitKind: 'FIRST_VISIT' | 'FOLLOW_UP' | null,
  ) {
    const visit =
      visitKind === 'FIRST_VISIT'
        ? ' · Primera vez'
        : visitKind === 'FOLLOW_UP'
          ? ' · Control'
          : '';
    // The field message IS the sentence: the screen announces a refusal by
    // its first field error, and «Ya existe» without naming it says nothing.
    const sentence = `Ya existe la consulta de ${specialtyName}${visit}: edítela`;
    super('Another active consultation has this specialty and visit', {}, [
      {
        field: visitKind === null ? 'specialtyId' : 'visitKind',
        code: 'CONSULTATION_DUPLICATE',
        message: sentence,
      },
    ]);
    this.userTitle = sentence;
  }
}

/**
 * BI-256, BI-286. The 024 mark reaches a procedure through the code the
 * service carries; a service that is not a procedure with its code has
 * nothing to mark.
 */
export class ServiceNotAProcedureError extends BusinessRuleViolation {
  readonly code = 'SERVICE_NOT_A_PROCEDURE';
  override readonly userTitle =
    'La marca del consentimiento 024 va en un procedimiento con su procedimiento del tarifario';

  constructor() {
    super('The written-consent mark needs a procedure with its code', {}, [
      {
        field: 'mspCode',
        code: 'SERVICE_NOT_A_PROCEDURE',
        message: 'Elija antes el procedimiento del tarifario',
      },
    ]);
  }
}

/**
 * BI-256, D-199.1. A service that demands the 024 keeps its procedure code:
 * changing or deleting it would move or remove the medical direction's mark
 * with a price manager's key. Unmarked first, then changed.
 */
export class ServiceConsentTieLockedError extends ConflictError {
  readonly code = 'SERVICE_CONSENT_TIE_LOCKED';
  override readonly userTitle =
    'Este servicio exige el consentimiento 024: la dirección médica tiene que desmarcarlo antes de cambiar su procedimiento o borrarlo';

  constructor() {
    super('A service demanding the form 024 keeps its procedure', {}, [
      {
        field: 'mspCode',
        code: 'SERVICE_CONSENT_TIE_LOCKED',
        message: 'Desmárquelo antes de cambiar el procedimiento',
      },
    ]);
  }
}

/**
 * BI-285. The RIDE reprints the service's MSP code, which no charge freezes:
 * changing it on a service already invoiced would rewrite what its issued
 * invoices say.
 */
export class ServiceTariffCodeInvoicedError extends ConflictError {
  readonly code = 'SERVICE_TARIFF_CODE_INVOICED';
  override readonly userTitle =
    'Este servicio ya salió en facturas con su Código MSP: cambiarlo cambiaría lo que dicen. Cree otro servicio';

  constructor() {
    super('Changing it would change the MSP code its invoices printed', {}, [
      {
        field: 'mspCode',
        code: 'SERVICE_TARIFF_CODE_INVOICED',
        message: 'Ya facturado con este Código MSP',
      },
    ]);
  }
}

/**
 * BI-281. The RIDE reprints the service's code too (the voucher's
 * `codigoPrincipal`): it does not change once invoiced.
 */
export class ServiceCodeInvoicedError extends ConflictError {
  readonly code = 'SERVICE_CODE_INVOICED';
  override readonly userTitle =
    'Este servicio ya salió en facturas con su código: cambiarlo cambiaría lo que dicen';

  constructor() {
    super('Changing it would change the code its invoices printed', {}, [
      {
        field: 'code',
        code: 'SERVICE_CODE_INVOICED',
        message: 'Ya facturado con este código',
      },
    ]);
  }
}

/**
 * BI-281, ORD-140. An order line froze the code: changing it would leave the
 * order naming a code that no longer exists.
 */
export class ServiceCodeOrderedError extends ConflictError {
  readonly code = 'EXAM_CODE_IN_USE';
  override readonly userTitle: string;

  /**
   * `exam`: a procedure already ordered keeps being orderable (BI-284) — its
   * order lines resolve their determinations and turnaround through it.
   */
  constructor(field: 'code' | 'exam' = 'code') {
    super('An order line already froze this code', {}, [
      {
        field,
        code: 'EXAM_CODE_IN_USE',
        message:
          field === 'code'
            ? 'Ya pedido con este código'
            : 'Ya pedido en una orden',
      },
    ]);
    this.userTitle =
      field === 'code'
        ? 'Ya se pidió en una orden con este código: no se puede cambiar'
        : 'Ya se pidió en una orden: sigue pidiéndose';
  }
}

/** BI-286. One procedure per code: caja would otherwise pick one in silence. */
export class ServiceProcedureTakenError extends ConflictError {
  readonly code = 'SERVICE_PROCEDURE_TAKEN';
  override readonly userTitle =
    'Otro servicio ya cobra ese procedimiento: cámbielo allí o elija otro';

  constructor() {
    super('Another service already charges that procedure', {}, [
      {
        field: 'mspCode',
        code: 'SERVICE_PROCEDURE_TAKEN',
        message: 'Otro servicio ya cobra ese procedimiento',
      },
    ]);
  }
}

/** BI-286. A procedure carries a code of the tariff, never one made up. */
export class ServiceProcedureNotInTariffError extends BusinessRuleViolation {
  readonly code = 'SERVICE_PROCEDURE_NOT_IN_TARIFF';
  override readonly userTitle =
    'Ese código no es de un procedimiento del tarifario: búsquelo en el tarifario';

  constructor() {
    super('The procedure code is not of the tariff catalogue', {}, [
      {
        field: 'mspCode',
        code: 'SERVICE_PROCEDURE_NOT_IN_TARIFF',
        message: 'Elija un procedimiento del tarifario',
      },
    ]);
  }
}

/** BI-015. */
export class BillableServiceInactiveError extends BusinessRuleViolation {
  readonly code = 'BILLABLE_SERVICE_INACTIVE';
  override readonly userTitle =
    'Ese servicio está desactivado y no se puede cobrar: elija otro o vuelva a activarlo';

  constructor() {
    super('Billable service is inactive and cannot be charged', {}, [
      {
        field: 'serviceId',
        code: 'BILLABLE_SERVICE_INACTIVE',
        message: 'Seleccione un servicio activo',
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
    'Indique el IVA del servicio: el sistema no lo deduce';

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
    'Ese IVA lo usan servicios del catálogo: cámbieselo antes de retirarlo';

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
    'El IVA de este servicio cambió mientras lo revisaba: vuelva a mirarlo antes de marcarlo revisado';

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

/**
 * BI-110. No published tariff yet, or no publication with that id. The public
 * view answers it too: there is nothing on the wall until somebody publishes.
 */
export class TariffPublicationNotFoundError extends NotFoundError {
  readonly code = 'TARIFF_PUBLICATION_NOT_FOUND';
  override readonly userTitle =
    'La clínica todavía no ha publicado su tarifario';

  constructor() {
    super('No tariff publication');
  }
}

/**
 * BI-111, BI-113. Nothing active with a self-pay price in force today: a wall
 * with an empty tariff tells the public nothing true.
 */
export class TariffPublicationEmptyError extends ConflictError {
  readonly code = 'TARIFF_PUBLICATION_EMPTY';
  override readonly userTitle =
    'No hay servicios activos con precio particular vigente que publicar';

  constructor() {
    super('No active service with a self-pay price in force');
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
    'No hay precio vigente para ese servicio, ese pagador y esa fecha de servicio';

  constructor(serviceId: string, payerId: string, serviceDate: ClinicalDate) {
    super(
      'No price in force for that service, payer and service date',
      { serviceId, payerId, serviceDate },
      [
        {
          field: 'serviceDate',
          code: 'PRICE_NOT_FOUND',
          message:
            'Compruebe la fecha del servicio y el pagador de la cuenta, o fije el precio de ese servicio',
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
 * BI-237 (D-184.2). An account with nothing invoiced is closed with the
 * reason it is not charged — «control sin costo», «cortesía» —, so that every
 * attention ends `COMPLETED` by the same path and it is written why it cost
 * nothing. `trg_patient_account_settled_states_why_unpaid` refuses it too.
 */
export class AccountNoChargeReasonRequiredError extends ValidationError {
  readonly code = 'ACCOUNT_NO_CHARGE_REASON_REQUIRED';
  override readonly userTitle =
    'No hay nada facturado: indique por qué no se cobra antes de cerrar la cuenta';

  constructor() {
    super(
      'An account with nothing invoiced needs the reason it is not charged',
      {},
      [
        {
          field: 'noChargeReason',
          code: 'ACCOUNT_NO_CHARGE_REASON_REQUIRED',
          message: 'Indique por qué no se cobra',
        },
      ],
    );
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
 * BI-305 (D-216 §1). «Enviar a caja» asked for a payer, and the visit's open
 * account has another one — opened a second earlier by somebody else, or
 * before. Handing back that account would charge the visit to a payer nobody
 * at this counter chose; the sentence names the one it has, so caja changes
 * it with «Cambiar pagador» if it must.
 *
 * The same code as the database's `patient_account_one_open_per_encounter`,
 * on purpose: it is the same fact said with what caja needs to act on it.
 */
export class AccountAlreadyOpenForEncounterError extends ConflictError {
  readonly code = 'ACCOUNT_ALREADY_OPEN_FOR_ENCOUNTER';
  override readonly userTitle: string;

  constructor(openPayerName: string) {
    super('The encounter already has an open account with another payer', {
      openPayerName,
    });
    this.userTitle = `Esta atención ya tiene una cuenta abierta con ${openPayerName}. Si debe pagar otro, ábrala y use «Cambiar pagador»`;
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

/** BI-303, BI-304. Another site's credit note answers the same (BI-135). */
export class CreditNoteNotFoundError extends NotFoundError {
  readonly code = 'CREDIT_NOTE_NOT_FOUND';
  override readonly userTitle = 'Esa nota de crédito no existe';

  constructor() {
    super('No credit note with that identifier in this site');
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
    this.userTitle = `El servicio «${serviceName}» tiene el código ${serviceCode}, más largo de los 25 caracteres que acepta el SRI. Administración debe acortarlo en el catálogo antes de facturarla`;
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

/**
 * BI-303, BI-304. Only a credit note the SRI returned or did not authorise is
 * corrected or given up: the others are the SRI's, or already given up.
 */
export class CreditNoteNotEditableError extends ConflictError {
  readonly code = 'CREDIT_NOTE_NOT_EDITABLE';
  override readonly userTitle =
    'Sólo una nota de crédito devuelta o no autorizada por el SRI se corrige o se desiste';

  constructor() {
    super('The credit note is not REJECTED');
  }
}

/**
 * BI-303. «Servicio no prestado» decided at issue whether the credited lines
 * came back to the account (BI-214); a correction cannot undo that.
 */
export class CreditNoteReasonKindFixedError extends ValidationError {
  readonly code = 'CREDIT_NOTE_REASON_KIND_FIXED';
  override readonly userTitle =
    'Ese motivo cambiaría lo que la nota ya decidió (si vuelve a facturar, a quién se envía): desista de ella y emita otra';

  constructor() {
    super('The reason cannot move across SERVICE_NOT_PROVIDED', {}, [
      {
        field: 'reasonCode',
        code: 'CREDIT_NOTE_REASON_KIND_FIXED',
        message: 'Elija un motivo del mismo tipo',
      },
    ]);
  }
}

/** BI-304. Giving a note up says why. */
export class CreditNoteWithdrawalReasonRequiredError extends ValidationError {
  readonly code = 'CREDIT_NOTE_WITHDRAWAL_REASON_REQUIRED';
  override readonly userTitle = 'Diga por qué desiste de la nota de crédito';

  constructor() {
    super('A withdrawal needs a reason', {}, [
      {
        field: 'reason',
        code: 'CREDIT_NOTE_WITHDRAWAL_REASON_REQUIRED',
        message: 'Escriba el motivo (hasta 300 caracteres)',
      },
    ]);
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

// ───────────────────────────────────────────────────────────────────────────
// What the clinic changes without a deploy (BI-140 to BI-147)
// ───────────────────────────────────────────────────────────────────────────

/** BI-100. */
export class PaymentMethodNotFoundError extends NotFoundError {
  readonly code = 'PAYMENT_METHOD_NOT_FOUND';
  override readonly userTitle = 'Ese medio de pago no existe';

  constructor() {
    super('No payment method with that identifier');
  }
}

/**
 * BI-146. Without one active method the cashier cannot issue a single
 * invoice, and finds out with the patient standing at the desk.
 */
export class LastActivePaymentMethodError extends ConflictError {
  readonly code = 'LAST_ACTIVE_PAYMENT_METHOD';
  override readonly userTitle =
    'Es el único medio de pago activo: active otro antes de desactivar éste';

  constructor() {
    super('Refusing to deactivate the only active payment method');
  }
}

/** BI-141. The role the limit was asked for does not exist. */
export class DiscountLimitRoleNotFoundError extends NotFoundError {
  readonly code = 'DISCOUNT_LIMIT_ROLE_NOT_FOUND';
  override readonly userTitle = 'Ese rol no existe';

  constructor() {
    super('No role with that identifier');
  }
}

/**
 * BI-144. Two «Deuna» in the cashier's selector are a question the cashier
 * cannot answer. Compared without case or surrounding spaces, as
 * `payment_method_name_unique` does; the index answers a race with
 * `DUPLICATE_VALUE`.
 */
export class PaymentMethodNameTakenError extends ConflictError {
  readonly code = 'PAYMENT_METHOD_NAME_TAKEN';
  override readonly userTitle = 'Ya hay un medio de pago con ese nombre';

  constructor() {
    super('Another payment method already has that name');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Discounts (BI-060 to BI-066, BI-244 to BI-246)
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-063. Above the ceiling of the caller's roles, and nobody else named to
 * authorise it.
 *
 * 403 AND NOT 422: the amount is well-formed and may well be right. What is
 * missing is a second person, and the sentence says where to find one. The
 * ceiling travels in `params` for whoever catches it; the screen already
 * showed it before asking (BI-245).
 */
export class DiscountExceedsLimitError extends ForbiddenError {
  readonly code = 'DISCOUNT_EXCEEDS_LIMIT';
  override readonly userTitle =
    'Ese descuento supera su límite: indique quién lo autoriza';

  constructor(maxDiscountPercentage: string) {
    super("The discount exceeds the ceiling of the requester's roles", {
      maxDiscountPercentage,
    });
  }
}

/**
 * BI-063. The person named as authoriser does not hold
 * `billing:discount-override` at this site — or does not exist, or is
 * inactive. One answer for all three, as `OVERBOOKING_NOT_AUTHORISED` does:
 * telling them apart would confirm which accounts exist, one guess at a time.
 */
export class DiscountNotAuthorisedError extends ForbiddenError {
  readonly code = 'DISCOUNT_NOT_AUTHORISED';
  override readonly userTitle =
    'Esa persona no puede autorizar descuentos en esta sede: elija a otra';

  constructor() {
    super('The named authoriser does not hold billing:discount-override here');
  }
}

/** BI-064. The shared code, with caja's sentence. */
export class DiscountSelfAuthorisationDeniedError extends SelfAuthorisationDeniedError {
  override readonly userTitle =
    'Un descuento por encima de su límite lo autoriza otra persona: elíjala en la lista';

  constructor() {
    super('The requester named themselves as the discount authoriser');
  }
}

/**
 * BI-244. The discount is in dollars and the ceiling a percentage: lowering
 * the quantity under a 10 % would turn it into a 50 % nobody authorised. So
 * the line keeps its amount while it carries a discount, and the way out is
 * to remove the discount first. `trg_charge_item_discount_is_permanent`
 * guarantees it; this is the sentence the service says before.
 */
export class ChargeHasDiscountError extends ConflictError {
  readonly code = 'CHARGE_HAS_DISCOUNT';
  override readonly userTitle =
    'Esta línea tiene un descuento: quítelo antes de cambiar la cantidad, el servicio, la fecha o el pagador';

  constructor() {
    super('A discounted line keeps its amount until the discount is removed');
  }
}

/**
 * BI-246. A proposal still moves with the clinical act (BI-240 to BI-243); a
 * discount on it would freeze it behind the doctor's back (BI-244).
 */
export class ChargeNotConfirmedError extends ConflictError {
  readonly code = 'CHARGE_NOT_CONFIRMED';
  override readonly userTitle =
    'Confirme el cargo antes de ponerle un descuento';

  constructor() {
    super('Only a confirmed charge takes a discount');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Payments and the daily close of cash (B6, BI-101 to BI-105, BI-247 to BI-253)
// ───────────────────────────────────────────────────────────────────────────

/** BI-101. `trg_payment_guard` decides it; this is what the desk reads. */
export class PaymentExceedsBalanceError extends BusinessRuleViolation {
  readonly code = 'PAYMENT_EXCEEDS_BALANCE';
  override readonly userTitle =
    'El cobro supera el saldo de la factura: revise el importe';

  constructor() {
    super('The payment exceeds the invoice balance');
  }
}

/**
 * BI-104, BI-253. A payment already in a close is not reversed: that would
 * change a photo that never changes. Undoing it is a refund (D-197.3).
 */
export class CashSessionClosedError extends ConflictError {
  readonly code = 'CASH_SESSION_CLOSED';
  override readonly userTitle =
    'Ese cobro ya está en un cierre de caja: no se puede revertir';

  constructor() {
    super('The payment is already in a closed cash session');
  }
}

/**
 * BI-252. The turn the cashier saw was closed meanwhile — another tab, or a
 * second click.
 */
export class CashSessionAlreadyClosedError extends ConflictError {
  readonly code = 'CASH_SESSION_ALREADY_CLOSED';
  override readonly userTitle =
    'Ese turno ya se cerró: revise los cierres de hoy';

  constructor() {
    super('The turn the cashier saw was already closed');
  }
}

/**
 * BI-255. Money came in while the cashier was counting: the difference she
 * confirmed is not the one that would be written.
 */
export class CashSessionChangedError extends ConflictError {
  readonly code = 'CASH_SESSION_CHANGED';
  override readonly userTitle =
    'Entró otro cobro mientras contaba: revise el efectivo esperado y vuelva a cerrar';

  constructor() {
    super('The expected cash changed after the cashier saw it');
  }
}

/** BI-252, D-200. A turn without payments has nothing to close. */
export class CashSessionEmptyError extends BusinessRuleViolation {
  readonly code = 'CASH_SESSION_EMPTY';
  override readonly userTitle = 'No hay cobros desde el último cierre';

  constructor() {
    super('Refusing to close a turn without payments');
  }
}

/**
 * BI-251, BI-135. Another person's payment, or another site's, answers like
 * one that does not exist.
 */
export class PaymentNotFoundError extends NotFoundError {
  readonly code = 'PAYMENT_NOT_FOUND';
  override readonly userTitle = 'Ese cobro no existe o no es suyo';

  constructor() {
    super('No payment of this user in this site with that identifier');
  }
}

/** BI-102. A reversal is written once. */
export class PaymentAlreadyReversedError extends ConflictError {
  readonly code = 'PAYMENT_ALREADY_REVERSED';
  override readonly userTitle = 'Ese cobro ya está revertido';

  constructor() {
    super('The payment was already reversed');
  }
}

/** BI-247, BI-248. Only an active method takes money. */
export class PaymentMethodInactiveError extends BusinessRuleViolation {
  readonly code = 'PAYMENT_METHOD_INACTIVE';
  override readonly userTitle = 'Ese medio de pago ya no está activo: elija otro'; // prettier-ignore

  constructor() {
    super('The payment method is not active');
  }
}

/**
 * BI-247. The invoice declares one SRI form of payment and the money came in
 * with another: the voucher would tell the SRI something that did not happen.
 */
export class PaymentMethodMismatchError extends BusinessRuleViolation {
  readonly code = 'PAYMENT_METHOD_MISMATCH';
  override readonly userTitle =
    'El medio del cobro no corresponde a la forma de pago de la factura';

  constructor() {
    super('The payment method does not declare the invoice payment form');
  }
}

/** BI-248. A draft or a voided invoice is not collected. */
export class InvoiceNotPayableError extends ConflictError {
  readonly code = 'INVOICE_NOT_PAYABLE';
  override readonly userTitle = 'Esa factura no se puede cobrar: está anulada o sin emitir'; // prettier-ignore

  constructor() {
    super('The invoice is not issued, or it is voided');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The «próximo número» of an emission point (BI-306, BI-307, D-262)
// ───────────────────────────────────────────────────────────────────────────

/** BI-306. Fixing where a point's numbering goes is said, not just done. */
export class NumberingReasonRequiredError extends ValidationError {
  readonly code = 'NUMBERING_REASON_REQUIRED';
  override readonly userTitle = 'Escriba por qué cambia el próximo número';

  constructor() {
    super('A reason is required to fix the next sequential', {}, [
      {
        field: 'reason',
        code: 'NUMBERING_REASON_REQUIRED',
        message: 'Escriba el motivo',
      },
    ]);
  }
}

/**
 * BI-307. At or below the largest used, the next voucher would take a number
 * this point already issued. `usedUpTo` says which, so the screen can offer
 * the first one allowed.
 */
export class NumberingBelowUsedError extends ConflictError {
  readonly code = 'NUMBERING_BELOW_USED';
  override readonly userTitle: string;

  constructor(readonly usedUpTo: number) {
    super(
      'The next sequential must be above the largest already used',
      { usedUpTo },
      [
        {
          field: 'nextSequential',
          code: 'NUMBERING_BELOW_USED',
          message: `Tiene que ser mayor que ${usedUpTo}`,
        },
      ],
    );
    this.userTitle = `El próximo número tiene que ser mayor que ${usedUpTo}, el último ya usado en este punto`;
  }
}

/** BI-306. Out of the requester's sites, or not there: the same answer. */
export class NumberingEmissionPointNotFoundError extends NotFoundError {
  readonly code = 'NUMBERING_EMISSION_POINT_NOT_FOUND';
  override readonly userTitle = 'Ese punto de emisión no existe';

  constructor() {
    super('No emission point with that identifier in this site');
  }
}
