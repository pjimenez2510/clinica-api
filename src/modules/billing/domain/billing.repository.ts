import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { ChargeStatus, DocumentTotals } from './charge';
import type { ChargeOrigin, ServiceMatch } from './charge-proposal';
import type { VisitSequence } from './clinical-acts.port';
import type { InvoiceReceiver, InvoiceStatus } from './invoice';
import type { Money, Percentage, Quantity } from './money';
import type { PriceChange, PriceRow } from './price-list';

/**
 * What billing needs from storage, stated without naming a database.
 *
 * PORTS: the application depends on these and the Prisma adapters implement
 * them. `dependency-cruiser` enforces the direction, and the split into two is
 * the same one the module makes in its services — what the clinic CHARGES FOR
 * (the catalogue, the payers, the tariffs) and what one visit OWES.
 *
 * ⚠️ WHY THERE ARE PATIENT AND ENCOUNTER FIELDS HERE AND NO IMPORT FROM THOSE
 * MODULES. An invoice has to be made out to somebody (BI-082) and an account
 * settles an encounter, so billing needs two facts that live in other modules'
 * tables. It does NOT reach for `modules/patients` or `modules/encounter` to
 * get them — no module imports another, and the day that rule is bent «just
 * for one lookup» the modules stop being modules. Billing declares the fields
 * it needs and its OWN adapter answers them, exactly as `agenda` does for the
 * merge state of a chart.
 *
 * ⚠️ AND NOTHING HERE ASKS A CLINICAL QUESTION. There is no method that says
 * whether an encounter may proceed, may be closed or may be signed, and there
 * never will be: Ley 77 art. 9 forbids conditioning care on payment (BI-003,
 * BI-120), and the way a system breaks that is never a decision — it is a
 * required field on the wrong screen. A port with no such method cannot grow
 * one by accident.
 */

// ───────────────────────────────────────────────────────────────────────────
// What the clinic charges for
// ───────────────────────────────────────────────────────────────────────────

export interface TaxRateView {
  id: string;
  sriCode: string;
  name: string;
  /** `null` for «no objeto» and «exento», which are NOT synonyms of 0%. */
  percentage: Percentage | null;
  validFrom: ClinicalDate;
  validTo: ClinicalDate | null;
}

/** A service, and NEVER an amount on it (BI-006). */
export interface BillableServiceView {
  id: string;
  code: string;
  name: string;
  category: string;
  /** MSP nomenclature only. No amount is ever taken from it (BI-011). */
  tariffCode: string | null;
  taxRateId: string;
  taxSriCode: string;
  taxPercentage: Percentage | null;
  active: boolean;
  /**
   * BI-158. Which consultation this service IS, when it is one.
   *
   * Both or neither (`billable_service_consultation_states_both`). Null on
   * almost every row: a gauze is nobody's consultation.
   */
  specialtyId: string | null;
  visitSequence: VisitSequence | null;
}

export interface PayerView {
  id: string;
  code: string;
  name: string;
  kind: PayerKind;
  ruc: string | null;
  agreementReference: string | null;
  agreementValidTo: ClinicalDate | null;
  active: boolean;
}

/**
 * `payer_kind_is_known`. A classification column, not the payer's identity:
 * it groups a report, and the ONLY behaviour that branches on it is BI-034.
 */
export const PAYER_KINDS = [
  'SELF_PAY',
  'PUBLIC_NETWORK',
  'PRIVATE_INSURANCE',
  'COMPANY_AGREEMENT',
] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

export interface PriceListView {
  id: string;
  name: string;
  payerId: string;
  siteId: string | null;
  publiclyListed: boolean;
  active: boolean;
}

export interface NewBillableService {
  code: string;
  name: string;
  category: string;
  tariffCode: string | null;
  taxRateId: string;
}

/**
 * BI-158. «This service IS the consultation of that specialty, of that kind».
 *
 * A pair and never half of one: `billable_service_consultation_states_both`
 * refuses a specialty with no sequence, and clearing it means clearing both.
 */
export interface ConsultationMapping {
  specialtyId: string;
  visitSequence: VisitSequence;
}

export interface BillableServiceUpdate {
  name?: string;
  category?: string;
  tariffCode?: string | null;
  taxRateId?: string;
  active?: boolean;
  /** BI-158. `null` unsets both columns; absent leaves them alone. */
  consultation?: ConsultationMapping | null;
}

export interface NewPayer {
  code: string;
  name: string;
  kind: PayerKind;
  ruc: string | null;
  agreementReference: string | null;
}

export interface PayerUpdate {
  name?: string;
  ruc?: string | null;
  agreementReference?: string | null;
  active?: boolean;
}

export interface BillingCatalogueRepository {
  /** BI-020, BI-021. The SRI's rates, as rows. */
  listTaxRates(): Promise<TaxRateView[]>;
  findTaxRate(taxRateId: string): Promise<TaxRateView | null>;
  /** BI-026. */
  countServicesUsingTaxRate(taxRateId: string): Promise<number>;

  /** BI-010, BI-014, BI-023. */
  listBillableServices(filter: {
    includeInactive: boolean;
  }): Promise<BillableServiceView[]>;
  findBillableService(serviceId: string): Promise<BillableServiceView | null>;
  createBillableService(service: NewBillableService): Promise<BillableServiceView>; // prettier-ignore
  updateBillableService(
    serviceId: string,
    update: BillableServiceUpdate,
  ): Promise<BillableServiceView>;
  /**
   * BI-012. Deletes ONLY when nothing references it; the caller has already
   * refused when it does. The count and the delete are asked separately on
   * purpose — the `RESTRICT` foreign keys are the real guarantee, and this
   * pair only turns their rejection into a sentence.
   */
  countReferencesToService(serviceId: string): Promise<number>;
  deleteBillableService(serviceId: string): Promise<void>;

  /**
   * BI-158. THE SERVICE THAT IS «THE CONSULTATION» of a specialty.
   *
   * `billable_service_one_per_consultation` makes the answer at most one row,
   * which is what stops the proposal from having to pick — and «se coge la
   * primera» is how a clinic charges the old consultation for months.
   */
  findConsultationService(
    mapping: ConsultationMapping,
  ): Promise<ServiceMatch | null>;

  /**
   * BI-151. `catalog_concept.id` → the service that charges for that
   * procedure, for a whole visit AT ONCE.
   *
   * A map and not a lookup per row: twelve procedures must not be twelve round
   * trips while a patient waits at the counter.
   */
  findServicesByProcedureConcept(
    conceptIds: readonly string[],
  ): Promise<Map<string, ServiceMatch>>;

  /**
   * BI-151. `exam_definition.code` → the service the definition already points
   * at through `billable_service_id`.
   *
   * ⚠️ THE JOIN IS BY CODE, and it is the code the order line FROZE
   * (`service_order_item.test_code`). Reading it back through the order's
   * catalogue concept would answer a different question — the concept is the
   * nomenclature of what was asked for, and what is charged is the orderable.
   */
  findServicesByExamCode(
    codes: readonly string[],
  ): Promise<Map<string, ServiceMatch>>;

  /** BI-030, BI-031. */
  listPayers(filter: { includeInactive: boolean }): Promise<PayerView[]>;
  findPayer(payerId: string): Promise<PayerView | null>;
  countActivePayers(): Promise<number>;
  countReferencesToPayer(payerId: string): Promise<number>;
  createPayer(payer: NewPayer): Promise<PayerView>;
  updatePayer(payerId: string, update: PayerUpdate): Promise<PayerView>;

  /** BI-040. One list per payer, for every site (`site_id IS NULL`). */
  findPriceListOfPayer(payerId: string): Promise<PriceListView | null>;
  /** BI-041, BI-042. Every price of one service in one list, newest first. */
  listPricesOfService(
    priceListId: string,
    billableServiceId: string,
  ): Promise<PriceRow[]>;
  listPricesOfList(priceListId: string): Promise<PriceRow[]>;
  /**
   * BI-044. The repricing, AS ONE TRANSACTION: closing the old validity and
   * opening the new one are two writes that must not be observable apart —
   * between them there would be either a hole with no price or an overlap
   * `price_temporal_unique` refuses.
   */
  applyPriceChange(
    priceListId: string,
    billableServiceId: string,
    change: PriceChange,
  ): Promise<PriceRow>;
}

export const BILLING_CATALOGUE_REPOSITORY = Symbol(
  'BillingCatalogueRepository',
);

// ───────────────────────────────────────────────────────────────────────────
// What one visit owes
// ───────────────────────────────────────────────────────────────────────────

export interface AccountView {
  id: string;
  siteId: string;
  patientId: string;
  encounterId: string | null;
  payerId: string;
  priceListId: string;
  status: AccountStatus;
  openedAt: Date;
  closedAt: Date | null;
}

/** `patient_account_status_is_known`. */
export const ACCOUNT_STATUSES = ['OPEN', 'SETTLED', 'CANCELLED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface ChargeView {
  id: string;
  accountId: string;
  billableServiceId: string;
  encounterId: string | null;
  serviceDate: ClinicalDate;
  quantity: Quantity;
  unitAmount: Money;
  resolvedPriceId: string | null;
  serviceDisplay: string;
  taxSriCode: string;
  taxPercentage: Percentage | null;
  discountAmount: Money;
  discountReason: string | null;
  discountAuthorisedById: string | null;
  status: ChargeStatus;
  createdById: string;
  /** BI-153. Where the line came from, and which clinical act it names. */
  origin: ChargeOrigin;
  encounterProcedureId: string | null;
  serviceOrderItemId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface NewAccount {
  siteId: string;
  patientId: string;
  encounterId: string | null;
  payerId: string;
  priceListId: string;
}

/**
 * A charge to be written, WITH THE ACT IT CAME FROM.
 *
 * `origin` decides which of the two identifiers may be filled in, and
 * `charge_item_origin_names_its_act` refuses the combinations that would leave
 * a line claiming an origin it cannot point at.
 */
export interface NewCharge {
  accountId: string;
  billableServiceId: string;
  encounterId: string | null;
  serviceDate: ClinicalDate;
  quantity: Quantity;
  createdById: string;
  origin: ChargeOrigin;
  encounterProcedureId: string | null;
  serviceOrderItemId: string | null;
  /**
   * BI-152. `BILLABLE` for what a person typed, `PLANNED` for what the system
   * derived: a derived line is a PROPOSAL until somebody confirms it, and
   * `issueInvoice` only ever takes `BILLABLE` rows.
   */
  status: Extract<ChargeStatus, 'PLANNED' | 'BILLABLE'>;
}

/** BI-154. The acts of one visit that a charge already names. */
export interface ChargedActs {
  /** Whether the CONSULTATION of this visit is already charged. */
  consultation: boolean;
  encounterProcedureIds: string[];
  serviceOrderItemIds: string[];
}

/** BI-082. The two facts about the patient an invoice needs, and no more. */
export interface AccountPatientIdentification {
  patientId: string;
  /** `patient_identifier.type` of the OFFICIAL identifier, when there is one. */
  identifierType: 'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL' | null; // prettier-ignore
  identifierValue: string | null;
  /** Filing order, as it is printed: «Guamán Andrade, María José». */
  fullName: string;
}

export interface InvoiceView {
  id: string;
  accountId: string;
  siteId: string;
  emissionPointId: string;
  sequential: string;
  accessKey: string | null;
  receiver: InvoiceReceiver;
  totals: DocumentTotals;
  status: InvoiceStatus;
  issuedAt: Date | null;
  authorisedAt: Date | null;
  issuedById: string;
}

/** Everything an invoice needs, with the receiver ALREADY resolved (BI-080). */
export interface InvoiceIssuance {
  accountId: string;
  siteId: string;
  emissionPointId: string;
  receiver: InvoiceReceiver;
  issuedById: string;
}

export interface BillingAccountRepository {
  /** BI-070, BI-121. */
  openAccount(account: NewAccount): Promise<AccountView>;
  /** BI-135. One account of one site, or `null` for anything else. */
  findAccount(query: {
    accountId: string;
    siteId: string;
  }): Promise<AccountView | null>;
  listAccounts(query: {
    siteId: string;
    patientId?: string;
    status?: AccountStatus;
  }): Promise<AccountView[]>;
  /** BI-033. Refused by the caller when the account already holds charges. */
  changeAccountPayer(
    accountId: string,
    payer: { payerId: string; priceListId: string },
  ): Promise<AccountView>;
  closeAccount(accountId: string): Promise<AccountView>;

  /** BI-074. Derived, never a column. */
  listCharges(accountId: string): Promise<ChargeView[]>;
  /**
   * BI-047, BI-050. Resolves the price by SERVICE DATE and freezes it, in ONE
   * transaction with the insert.
   *
   * THE RESOLUTION IS THE ADAPTER'S because the account's price list and the
   * date decide it with a single query the database can answer under the
   * `price_temporal_unique` guarantee — and because reading the price in the
   * service and inserting afterwards leaves a window in which the tariff
   * changes between the two, which is the one window this whole design exists
   * to close.
   */
  addCharge(command: NewCharge): Promise<ChargeView>;

  /**
   * BI-150. The OPEN account of a visit, or `null`.
   *
   * `patient_account_one_open_per_encounter` — partial unique, `WHERE status =
   * 'OPEN' AND encounter_id IS NOT NULL` — makes the answer at most one row.
   * That index is what lets «open or recover» be a question with one answer
   * instead of a race between two cashiers pressing the same button.
   */
  findOpenAccountOfEncounter(query: {
    encounterId: string;
    siteId: string;
  }): Promise<AccountView | null>;

  /**
   * BI-154, BI-157. Which acts of this visit ALREADY have a charge.
   *
   * ⚠️ ASKED ACROSS THE VISIT AND NOT ACROSS ONE ACCOUNT, and voided charges
   * count. A charge the cashier removed stays in the table (BI-055) and must
   * not come back on the next press; and an act charged on a previous account
   * of the same visit is charged, whichever account it landed on. Scoping this
   * to the current account would resurrect both.
   */
  listChargedActs(encounterId: string): Promise<ChargedActs>;

  /** BI-135. One charge of one account of one site, or `null`. */
  findCharge(query: {
    chargeId: string;
    accountId: string;
  }): Promise<ChargeView | null>;

  /**
   * BI-152. A proposed line the cashier accepted: `PLANNED` → `BILLABLE`.
   *
   * Nothing is recomputed and no amount moves: the frozen block was written
   * when the charge was raised (BI-050), and confirming is a person saying
   * «yes, this is charged for», not a second pricing.
   */
  confirmCharge(chargeId: string): Promise<ChargeView>;

  /**
   * BI-055, BI-059. Voids a charge, KEEPING THE ROW.
   *
   * The three void columns travel together —
   * `charge_item_void_states_who_when_and_why` refuses one without the others
   * — and `charge_item_void_matches_status` keeps the status and the instant
   * from disagreeing. Nothing here touches a clinical row: BI-004.
   */
  voidCharge(command: {
    chargeId: string;
    voidedById: string;
    reason: string;
  }): Promise<ChargeView>;

  /** BI-082. */
  findAccountPatient(accountId: string): Promise<AccountPatientIdentification | null>; // prettier-ignore

  /**
   * BI-085. The emission point of THIS site, or `null`.
   *
   * Scoped by site for the same reason every read here is: an emission point
   * belongs to an establishment, and invoicing a Norte account through Sur's
   * point produces a voucher the SRI attributes to the wrong establishment.
   */
  findEmissionPoint(query: {
    emissionPointId: string;
    siteId: string;
  }): Promise<{ id: string; code: string; active: boolean } | null>;

  /**
   * BI-085, BI-086, BI-088. Issues the invoice, AS ONE TRANSACTION.
   *
   * ⚠️ THE SEQUENTIAL IS ALLOCATED INSIDE IT, under the emission point's own
   * row lock. Two cashiers invoicing at the same second is not hypothetical —
   * it is SC-023 — and a number read before the transaction is a number two
   * transactions read the same.
   *
   * The charges move to `BILLED` in the same transaction, which is what makes
   * BI-088 true here: a second issuance finds nothing left to bill and is
   * refused with `INVOICE_HAS_NO_ITEMS`.
   */
  issueInvoice(issuance: InvoiceIssuance): Promise<InvoiceView>;
  findInvoice(query: {
    invoiceId: string;
    siteId: string;
  }): Promise<InvoiceView | null>;
  listInvoices(query: {
    siteId: string;
    accountId?: string;
  }): Promise<InvoiceView[]>;
}

export const BILLING_ACCOUNT_REPOSITORY = Symbol('BillingAccountRepository');
