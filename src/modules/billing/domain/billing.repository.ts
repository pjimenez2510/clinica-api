import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { ChargeStatus, DocumentTotals } from './charge';
import type { ChargeOrigin, ServiceMatch } from './charge-proposal';
import type { InvoiceReceiver, InvoiceStatus, PaymentMethod } from './invoice';
import type { Money, Percentage, Quantity } from './money';
import type { PatientIdentity } from './patient-identity';
import type { PriceChange, PriceRow, ValidityPeriod } from './price-list';
import type { IssuedDocumentFilter } from './document-search';

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

/**
 * BI-020. One SRI rate with its validity; historical rates (12%, 14%) are rows
 * whose `validTo` is set, kept so an old invoice stays readable.
 */
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
/**
 * BI-186. The kinds a category can be: the three of a service order
 * (`service_order_category`) plus the consultation, a supply and anything else.
 * `billable_service_category_kind_is_known` holds the same list.
 */
export const SERVICE_CATEGORY_KINDS = [
  'CONSULTATION',
  'PROCEDURE',
  'LABORATORY',
  'IMAGING',
  'SUPPLY',
  'OTHER',
] as const;
export type ServiceCategoryKind = (typeof SERVICE_CATEGORY_KINDS)[number];

/**
 * BI-189. One price of a service in one payer's list, with its validity. The
 * service's card answers «how much is this, to whom, since when» in one place.
 */
export interface ServicePriceView extends ValidityPeriod {
  priceId: string;
  payer: { id: string; name: string; kind: PayerKind };
  amount: Money;
}

/**
 * BI-188. An exam of the exam catalogue charged through this service
 * (`exam_definition.billable_service_id`). Read only: the exam catalogue is
 * its own module's.
 */
export interface ServiceExamView {
  id: string;
  code: string;
  name: string;
  /** ORD-108. The exam's type, which is the class its service must be. */
  category: string;
  active: boolean;
}

/** BI-185. One category of the clinic's catalogue of services. */
export interface ServiceCategoryView {
  id: string;
  name: string;
  /** Fixed once created: what structure its services admit (BI-187). */
  kind: ServiceCategoryKind;
  active: boolean;
}

export interface BillableServiceView {
  id: string;
  code: string;
  name: string;
  /** BI-185. The catalogue row, never free text. */
  category: ServiceCategoryView;
  /**
   * BI-151, BI-187. The procedure this service charges, when it is one. Read
   * here and set nowhere in the API yet: the tie is seeded.
   */
  procedureConcept: { id: string; code: string; display: string } | null;
  /** MSP nomenclature only. No amount is ever taken from it (BI-011). */
  tariffCode: string | null;
  taxRateId: string;
  taxSriCode: string;
  taxPercentage: Percentage | null;
  active: boolean;
  /**
   * BI-158, BI-188, SP-031. The service types this service charges for, when
   * it is a consultation; empty on almost every row. Set from Especialidades,
   * never from here (SP-030).
   */
  serviceTypes: readonly ChargedServiceType[];
  /**
   * BI-022 to BI-024. Who checked the tax rate with accounting judgement, and
   * when; `null` is «pendiente de revisión». Every service is born pending
   * (D-172.1), and changing its rate makes it pending again (D-172.2).
   */
  taxReview: TaxReviewView | null;
}

/** BI-024. A review names a person and an instant, never one without the other. */
export interface TaxReviewView {
  reviewedAt: Date;
  reviewedById: string;
  /** «Nombre Apellido», as the screen says who. */
  reviewedByName: string;
}

/**
 * BI-030. Who the price list belongs to — a row, never an enum. `ruc` is
 * required only for institutional kinds (BI-034); the payer is NOT the invoice
 * receiver (BI-035).
 */
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
/** One of `PAYER_KINDS`. */
export type PayerKind = (typeof PAYER_KINDS)[number];

/**
 * BI-040. `siteId` null means every site, which is the list this delivery
 * resolves prices from. `publiclyListed` is `price_list.publicly_listed`, the
 * LOS art. 184 obligation to display the tariff to the public (delivery B5).
 */
export interface PriceListView {
  id: string;
  name: string;
  payerId: string;
  siteId: string | null;
  publiclyListed: boolean;
  active: boolean;
}

/**
 * BI-010, BI-013. A new service: the tax rate is mandatory, and there is no
 * amount on it — prices live in the price lists (BI-006).
 */
export interface NewBillableService {
  code: string;
  name: string;
  categoryId: string;
  tariffCode: string | null;
  taxRateId: string;
}

/** BI-188, SP-031. A service type a consultation service charges for. */
export interface ChargedServiceType {
  id: string;
  name: string;
  specialtyName: string;
}

/**
 * A partial update: an absent field is left alone. `code` is not here, so the
 * identifier a charge was raised against cannot be renamed.
 */
export interface BillableServiceUpdate {
  name?: string;
  categoryId?: string;
  tariffCode?: string | null;
  taxRateId?: string;
  active?: boolean;
  /**
   * BI-024. A review to record, or `null` to return the rate to pending;
   * absent leaves it alone. Written by the service, never taken from a body.
   */
  taxReview?: { reviewedAt: Date; reviewedById: string } | null;
}

/**
 * BI-030. A new payer; the service checks the RUC for institutional kinds
 * before this reaches storage (BI-034).
 */
export interface NewPayer {
  code: string;
  name: string;
  kind: PayerKind;
  ruc: string | null;
  agreementReference: string | null;
}

/** A partial update. `code` and `kind` are not editable here. */
export interface PayerUpdate {
  name?: string;
  ruc?: string | null;
  agreementReference?: string | null;
  active?: boolean;
}

/**
 * The port for WHAT THE CLINIC CHARGES FOR: tax rates, services, payers and
 * their price lists. Implemented by `PrismaBillingCatalogueRepository`.
 */
export interface BillingCatalogueRepository {
  /** BI-020, BI-021. The SRI's rates, as rows. */
  /** BI-185. The categories, the inactive ones only when asked. */
  listServiceCategories(filter: {
    includeInactive: boolean;
  }): Promise<ServiceCategoryView[]>;
  findServiceCategory(categoryId: string): Promise<ServiceCategoryView | null>;
  /** `billable_service_category_name_unique` refuses a repeated name. */
  createServiceCategory(category: {
    name: string;
    kind: ServiceCategoryKind;
  }): Promise<ServiceCategoryView>;
  updateServiceCategory(
    categoryId: string,
    update: { name?: string; active?: boolean; kind?: ServiceCategoryKind },
  ): Promise<ServiceCategoryView>;
  /**
   * BI-187. How many of the category's services carry each kind of tie, and
   * the types of the exams charged through them (ORD-108).
   */
  countCategoryTies(categoryId: string): Promise<{
    consultations: number;
    procedures: number;
    examCategories: string[];
  }>;

  /** BI-189. Every list's prices of the service, every validity. */
  listPricesAcrossPayers(serviceId: string): Promise<ServicePriceView[]>;
  /** BI-188. The exams charged through the service. */
  listExamsOfService(serviceId: string): Promise<ServiceExamView[]>;

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
  /**
   * A partial update. When it carries a `taxRateId` different from the one
   * stored, the tax review is cleared IN THE SAME TRANSACTION, whatever the
   * caller read before (BI-024, D-172.2): a review must never survive onto a
   * rate its author did not see.
   */
  updateBillableService(
    serviceId: string,
    update: BillableServiceUpdate,
  ): Promise<BillableServiceView>;
  /**
   * BI-024. Records the review ONLY IF the service still carries `taxRateId`,
   * in the same statement; `null` when it no longer does (or does not
   * exist). A read first and a write after would leave the window in which
   * another administrator changes the rate and the review signs the new one.
   */
  markTaxReviewed(
    serviceId: string,
    taxRateId: string,
    review: { reviewedAt: Date; reviewedById: string },
  ): Promise<BillableServiceView | null>;
  /**
   * BI-012. Deletes ONLY when nothing references it; the caller has already
   * refused when it does. The count and the delete are asked separately on
   * purpose — the `RESTRICT` foreign keys are the real guarantee, and this
   * pair only turns their rejection into a sentence.
   */
  countReferencesToService(serviceId: string): Promise<number>;
  deleteBillableService(serviceId: string): Promise<void>;

  /**
   * BI-158, SP-031. THE SERVICE THAT IS «THE CONSULTATION» of a service type:
   * its first (`position` 0). `service_type_billable_service_one_per_position`
   * makes it at most one row, so the proposal never has to pick.
   */
  findConsultationService(serviceTypeId: string): Promise<ServiceMatch | null>;

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
  /** BI-230. One price row with the list it belongs to, or `null`. */
  findPrice(
    priceId: string,
  ): Promise<(PriceRow & { priceListId: string }) | null>;
  /**
   * BI-230. Rewrites the amount of one row with the stamp of who corrected it;
   * `trg_price_record_version` archives the previous row in the same statement.
   */
  correctPriceAmount(
    priceId: string,
    amount: Money,
    stamp: { by: string; at: Date },
  ): Promise<PriceRow>;
  /**
   * BI-230. Charges not yet invoiced (planned or billable) that froze this
   * price at `amount`: they keep it (BI-050), so whoever corrects has to know.
   */
  countOpenChargesAt(priceId: string, amount: Money): Promise<number>;
}

export const BILLING_CATALOGUE_REPOSITORY = Symbol(
  'BillingCatalogueRepository',
);

// ───────────────────────────────────────────────────────────────────────────
// What one visit owes
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-070. An account groups one patient's charges against one payer. The price
 * list is fixed when it opens, and there is no total field: it is derived from
 * the charges (BI-074).
 */
export interface AccountView {
  id: string;
  siteId: string;
  patientId: string;
  /** BI-183. Who is being charged, as caja needs to recognise them. */
  patient: PatientIdentity;
  encounterId: string | null;
  payerId: string;
  priceListId: string;
  status: AccountStatus;
  openedAt: Date;
  closedAt: Date | null;
  /** BI-237. Why it was closed with nothing charged, if it was. */
  noChargeReason: string | null;
}

/** `patient_account_status_is_known`. */
export const ACCOUNT_STATUSES = ['OPEN', 'SETTLED', 'CANCELLED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * A charge as stored, frozen block included (BI-050). The void columns are null
 * unless `status` is `CANCELLED`.
 */
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
  /** BI-066. When the second person authorised it; null within the ceiling. */
  discountAuthorisedAt: Date | null;
  discountAuthorisedByName: string | null;
  /** BI-066. Who put the discount on the line, and when — not `createdById`. */
  discountAppliedById: string | null;
  discountAppliedAt: Date | null;
  discountAppliedByName: string | null;
  status: ChargeStatus;
  createdById: string;
  /** BI-153. Where the line came from, and which clinical act it names. */
  origin: ChargeOrigin;
  encounterProcedureId: string | null;
  serviceOrderItemId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  /** BI-169. The invoice that billed it, while it is BILLED. */
  invoiceId: string | null;
  /** BI-214. On a CORRECTION line, the credited charge it bills again. */
  correctsChargeItemId: string | null;
}

/**
 * BI-070. The payer and its price list are decided when the account is opened.
 */
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
  /**
   * BI-242. The procedures whose charge is not removed: a restored procedure
   * is charged by its former row's line while that line stands.
   */
  liveEncounterProcedureIds?: string[];
  serviceOrderItemIds: string[];
}

/** BI-082. The two facts about the patient an invoice needs, and no more. */
export interface AccountPatientIdentification {
  patientId: string;
  /** `patient_identifier.type` of the OFFICIAL identifier, when there is one. */
  identifierType: 'CEDULA' | 'PASSPORT' | 'REFUGEE_CARD' | 'FOREIGN_ID' | 'PROVISIONAL' | null; // prettier-ignore
  /** ISO 3166-1 alpha-3 of whoever issued it: a `CEDULA` not issued by `ECU` is foreign. */
  identifierIssuingCountry: string | null;
  identifierValue: string | null;
  /** Filing order, as it is printed: «Guamán Andrade, María José». */
  fullName: string;
}

/**
 * An issued invoice. There are no lines: its items are the account's `BILLED`
 * charges, and what is frozen here again are the totals and the receiver.
 */
export interface InvoiceView {
  id: string;
  accountId: string;
  siteId: string;
  emissionPointId: string;
  sequential: string;
  /** D-185.1, BI-235. The printed number, `001-002-000000123` (SRI-019). */
  documentNumber: string;
  accessKey: string | null;
  receiver: InvoiceReceiver;
  totals: DocumentTotals;
  status: InvoiceStatus;
  /** BI-170. `null` only on invoices issued before it was asked. */
  paymentMethod: PaymentMethod | null;
  issuedAt: Date | null;
  authorisedAt: Date | null;
  issuedById: string;
}

/** Everything an invoice needs, with the receiver ALREADY resolved (BI-080). */
/** BI-195 to BI-198. Who corrects and the app's instant (D-127.2). */
export interface ChargeStamp {
  chargeId: string;
  changedById: string;
  now: Date;
}

/** BI-060 to BI-066. One discount act on one line. */
export interface DiscountWrite extends ChargeStamp {
  reason: string | null;
  /** Under the row lock: the amount and whose second signature it carries. */
  decide: (current: ChargeView) => {
    amount: Money;
    authorisedById: string | null;
  };
}

/** BI-197. What an in-place edit may change; absent keys stay as they are. */
export interface ChargeEdit extends ChargeStamp {
  /** BI-243. Only if, under the row's lock, it still has this status. */
  onlyIfStatus?: ChargeStatus;
  quantity?: Quantity;
  serviceDate?: ClinicalDate;
  billableServiceId?: string;
}

/** BI-198. An open line and what it would cost under another list. */
export interface RepricedLine {
  chargeId: string;
  /** `null`: that list has no price for the line's service on its date. */
  unitAmount: Money | null;
}

export interface InvoiceIssuance {
  accountId: string;
  siteId: string;
  emissionPointId: string;
  receiver: InvoiceReceiver;
  /** BI-170. */
  paymentMethod: PaymentMethod;
  issuedById: string;
  /**
   * BI-184. The pending charges the cashier saw. When present, the issuance
   * is refused unless they are exactly the ones still pending.
   */
  expectedChargeIds?: readonly string[];
  /**
   * BI-184, BI-197. The total the cashier was shown. A line edited in place
   * keeps its id, so the ids alone no longer prove the amount.
   */
  expectedTotal?: Money;
}

/**
 * The port for WHAT ONE VISIT OWES: accounts, charges and invoices. Every read
 * is scoped by site. Implemented by `PrismaBillingAccountRepository`.
 */
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
  /**
   * BI-198. The payer and its list change, and every OPEN line is repriced
   * from the new list on its service date, in ONE transaction: a billed line
   * refuses it (`ACCOUNT_HAS_BILLED_CHARGES`), a missing price too
   * (`PRICE_NOT_FOUND`), and either way nothing changes.
   */
  changeAccountPayer(command: {
    accountId: string;
    payerId: string;
    priceListId: string;
    changedById: string;
    now: Date;
  }): Promise<AccountView>;
  /**
   * BI-072, BI-236, BI-237. Settles the account; the database closes its
   * discharged attention in the same transaction
   * (`trg_patient_account_closes_its_encounter`).
   */
  closeAccount(command: {
    accountId: string;
    closedById: string;
    /** BI-237. Why nothing was charged; `null` when something was invoiced. */
    noChargeReason: string | null;
    now: Date;
  }): Promise<AccountView>;

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
   * BI-055, BI-195. Removes a charge, KEEPING THE ROW.
   *
   * Who and when travel together (`charge_item_void_states_who_and_when`);
   * the reason is optional (D-126.1) and kept when given. The previous row is
   * archived by the database (`record_version`), which is what lets
   * `restoreCharge` put it back. Nothing here touches a clinical row: BI-004.
   */
  voidCharge(command: {
    chargeId: string;
    voidedById: string;
    reason: string | null;
    now: Date;
    /** BI-243. Only if, under the row's lock, it still has this status. */
    onlyIfStatus?: ChargeStatus;
  }): Promise<ChargeView>;

  /**
   * BI-203. The visit's consultation line, whatever its status — there is
   * at most one (`charge_item_one_consultation_per_encounter`).
   */
  findConsultationCharge(encounterId: string): Promise<ChargeView | null>;

  /**
   * BI-240 to BI-243. The charge a procedure raised, whatever its status —
   * there is at most one (`charge_item_one_per_encounter_procedure`).
   */
  findProcedureCharge(encounterProcedureId: string): Promise<ChargeView | null>;

  /** BI-196. An open line of $0 becomes `NOT_BILLABLE`, with its version. */
  markNotBillable(command: ChargeStamp): Promise<ChargeView>;

  /**
   * BI-195, BI-196. «Deshacer»: a removed or not-billable line goes back to
   * the status it had, repriced from the account's CURRENT list on its
   * service date. Refuses with `CHARGE_NOT_REMOVED` a line that is neither.
   */
  restoreCharge(command: ChargeStamp): Promise<ChargeView>;

  /**
   * BI-197. Edits an open line in place. A new service or date re-resolves
   * the frozen block from the account's list; quantity alone does not. A line
   * that is no longer open is refused with `CHARGE_ITEM_ALREADY_INVOICED` or
   * `CHARGE_ALREADY_VOIDED`.
   */
  editCharge(command: ChargeEdit): Promise<ChargeView>;

  /**
   * BI-060 to BI-066, BI-246. Puts, replaces or removes (amount zero) the
   * discount of one line, IN ONE TRANSACTION WITH THE ROW LOCKED: `decide`
   * reads the line as it is under the lock, so a quantity edited a moment
   * before cannot turn an authorised 10 % into a 50 % (BI-244). Refuses a
   * proposal with `CHARGE_NOT_CONFIRMED` and a line that left review as
   * `editCharge` does.
   */
  applyDiscount(command: DiscountWrite): Promise<ChargeView>;

  /**
   * BI-062. The ceilings of the roles the user holds AT THIS SITE or across
   * the clinic, active grants of active roles of an active account only. A
   * role without a row contributes nothing: zero (BI-141).
   */
  discountCeilings(query: {
    userId: string;
    siteId: string;
  }): Promise<Percentage[]>;

  /**
   * BI-063. What the named person holds at this site. Empty for an account
   * that does not exist or is inactive, so «no existe» and «no puede» answer
   * the same.
   */
  permissionsAt(query: {
    userId: string;
    siteId: string;
  }): Promise<readonly string[]>;

  /**
   * BI-245. The other active users who hold `billing:discount-override` at
   * this site, by name, for the cashier to pick from.
   */
  discountAuthorisers(query: {
    siteId: string;
    permission: string;
    exceptUserId: string;
  }): Promise<{ userId: string; name: string }[]>;

  /**
   * BI-198. What each OPEN line would cost in `priceListId`, without writing:
   * `null` where that list has no price on the line's service date.
   */
  previewRepricing(query: {
    accountId: string;
    priceListId: string;
  }): Promise<RepricedLine[]>;

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
  /** BI-133, BI-233. A page of the site's invoices, newest first, and the count. */
  listInvoices(query: {
    siteId: string;
    accountId?: string;
    filter: IssuedDocumentFilter;
    page: number;
    pageSize: number;
  }): Promise<{ items: InvoiceView[]; total: number }>;

  /**
   * BI-216, BI-217. The receiver and the payment method of an invoice the SRI
   * returned or did not authorise, stamped so the database archives the
   * previous row (`record_version`). `null` when it is no longer `REJECTED`:
   * the database refuses it in any other status
   * (`trg_invoice_receiver_editable_only_when_rejected`).
   */
  correctRejectedInvoice(correction: {
    invoiceId: string;
    siteId: string;
    receiver: InvoiceReceiver;
    paymentMethod: PaymentMethod;
    changedById: string;
    now: Date;
  }): Promise<InvoiceView | null>;
}

export const BILLING_ACCOUNT_REPOSITORY = Symbol('BillingAccountRepository');
