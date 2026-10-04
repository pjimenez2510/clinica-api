import { Inject, Injectable } from '@nestjs/common';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  BILLING_CATALOGUE_REPOSITORY,
  type BillableServiceUpdate,
  type BillableServiceView,
  type BillingCatalogueRepository,
  type NewBillableService,
  type ServiceCategoryKind,
  type ServiceCategoryView,
  type ServiceExamView,
  type ServicePriceView,
  type TaxRateView,
} from '../domain/billing.repository';
import { isInForceOn } from '../domain/price-list';
import {
  BillableServiceInUseError,
  BillableServiceNotFoundError,
  ServiceCategoryInactiveError,
  ServiceCategoryNotFoundError,
  ServiceKindMismatchError,
  TaxRateNotFoundError,
  TaxRateRequiredError,
} from '../domain/billing.errors';

/** Who is asking, for the trail BI-046 and BI-132 demand. */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * `access_audit.resource_type` for the two things this service changes.
 *
 * ⚠️ NO `before`/`after` PAYLOAD ON EITHER, and it is not an omission:
 * `access_audit_payload_only_for_declared_resources` whitelists exactly
 * `'configuration'`, and because a failure to record does not throw, a row
 * with a payload on any other resource type would be silently LOST — the trail
 * would look thinner than the truth, which is the worst failure a trail has.
 */
const SERVICE_RESOURCE_TYPE = 'billable_service';
const CATEGORY_RESOURCE_TYPE = 'billable_service_category';

/**
 * The catalogue of what the clinic knows how to do — WITHOUT A PRICE.
 *
 * ⚠️ BI-006 IS THIS SERVICE'S REASON TO EXIST AS A SEPARATE ONE. The classic
 * mistake is storing the price on the service; it breaks the first day an
 * insurer pays differently, and again when prices rise and every past invoice
 * silently changes with them. Nothing here takes, returns or writes an amount,
 * and `billable_service` has no amount column for it to write to. The
 * temptation does not appear while designing — it appears when somebody needs
 * «el precio» on a screen and a column looks cheaper than a query.
 *
 * SEPARATE FROM `PricingService` for the third of ADR-008 §2's limits: the two
 * change for different reasons — one when the clinic learns to do something
 * new, the other when it charges differently for what it already does — and
 * they share no method. Both are administered under `billing:price-manage`
 * (BI-046), which is what keeps a single screen behind a single permission.
 */
@Injectable()
export class ServiceCatalogueService {
  constructor(
    @Inject(BILLING_CATALOGUE_REPOSITORY)
    private readonly catalogue: BillingCatalogueRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * BI-020, BI-021. The SRI's rates, as rows and with their validity.
   *
   * The validity is served and not filtered to «the ones in force»: 12% and
   * 14% existed, and a 2016 invoice has to be readable. What must never happen
   * is EMITTING with one of them, and that is the catalogue screen's job, not
   * this list's.
   */
  async listTaxRates(): Promise<TaxRateView[]> {
    return this.catalogue.listTaxRates();
  }

  /** BI-010, BI-014, BI-023. */
  async listServices(options: {
    includeInactive: boolean;
  }): Promise<BillableServiceView[]> {
    return this.catalogue.listBillableServices(options);
  }

  /**
   * BI-010, BI-013. Creates a service, and DEMANDS ITS TAX RATE.
   *
   * ⚠️ THE RATE IS NOT INFERRED FROM ANYTHING (BI-005, D-A-006). Health
   * services are 0% by LRTI art. 56.2, but the 0% depends on the PROVIDER and
   * not on the service — art. 191 of the regulation conditions it on an
   * authorised establishment and a registered third-level degree, and excludes
   * cosmetic surgery and cosmetology, which go to the general rate. A rule
   * that deduced «this is health, therefore 0%» would be right almost always
   * and wrong exactly where there is an audit.
   *
   * ⚠️ AND THE REQUIREMENT LIVES HERE, NOT IN THE DTO. A `DEBERÁ` enforced
   * only at the transport layer stops being a guarantee the moment another use
   * case calls the service from inside — the same reasoning that moved
   * `CANCELLATION_REASON_REQUIRED` into the service in `agenda`.
   *
   * The unicity of `code` is NOT checked first: `billable_service_code_unique`
   * is the guarantee, and a SELECT before the INSERT would only add a window
   * between them.
   */
  async createService(
    service: NewBillableService,
    requester: Requester,
  ): Promise<BillableServiceView> {
    if (!service.taxRateId) throw new TaxRateRequiredError();
    await this.requireTaxRate(service.taxRateId);
    await this.requireActiveCategory(service.categoryId);

    const created = await this.catalogue.createBillableService(service);
    await this.recordChange(created.id, 'CREATE', requester);
    return created;
  }

  /**
   * BI-011, BI-014, BI-025. Changes a service, INCLUDING ITS RATE.
   *
   * ⚠️ CHANGING THE RATE CHANGES NOTHING ALREADY CHARGED (BI-025). Every
   * charge froze `tax_sri_code` and `tax_percentage` on the day it was raised,
   * so this write cannot reach a single existing row — there is no update here
   * that touches `charge_item`, and that absence is the requirement. It is
   * said apart from BI-053 because tax is the field that most invites
   * recomputation: it looks derived and it is not.
   */
  async updateService(
    serviceId: string,
    update: BillableServiceUpdate,
    requester: Requester,
  ): Promise<BillableServiceView> {
    const current = await this.requireService(serviceId);
    if (update.taxRateId !== undefined) {
      if (!update.taxRateId) throw new TaxRateRequiredError();
      await this.requireTaxRate(update.taxRateId);
    }
    const category =
      update.categoryId === undefined ||
      update.categoryId === current.category.id
        ? current.category
        : await this.requireActiveCategory(update.categoryId);
    assertKindAdmits(category.kind, {
      consultation:
        update.consultation === undefined
          ? current.specialtyId !== null
          : update.consultation !== null,
      procedure: current.procedureConcept !== null,
    });

    const updated = await this.catalogue.updateBillableService(
      serviceId,
      update,
    );
    await this.recordChange(serviceId, 'UPDATE', requester);
    return updated;
  }

  /**
   * BI-012. Refuses to delete a service anything references, and says so.
   *
   * The real guarantee is the `RESTRICT` on `price_service_fk` and
   * `charge_item_service_fk`; this count only turns that rejection into a
   * sentence naming the way out — deactivate it — instead of a generic
   * conflict. The service an eight-month-old invoice names has to keep
   * existing for that invoice to be readable at all.
   */
  async deleteService(serviceId: string, requester: Requester): Promise<void> {
    await this.requireService(serviceId);

    const references = await this.catalogue.countReferencesToService(serviceId);
    if (references > 0) throw new BillableServiceInUseError();

    await this.catalogue.deleteBillableService(serviceId);
    await this.recordChange(serviceId, 'UPDATE', requester);
  }

  /**
   * BI-189. The service's prices in every list, each marked in force or not
   * on `today` — the clinic date in Ecuador, which the caller resolves.
   */
  async servicePrices(
    serviceId: string,
    today: ClinicalDate,
  ): Promise<(ServicePriceView & { inForce: boolean })[]> {
    await this.requireService(serviceId);
    const prices = await this.catalogue.listPricesAcrossPayers(serviceId);
    return prices.map((price) => ({
      ...price,
      inForce: isInForceOn(price, today),
    }));
  }

  /** BI-188. The exams the service charges for, read from their catalogue. */
  async serviceExams(serviceId: string): Promise<ServiceExamView[]> {
    await this.requireService(serviceId);
    return this.catalogue.listExamsOfService(serviceId);
  }

  /** BI-185. The catalogue of categories; the inactive ones on request. */
  async listCategories(options: {
    includeInactive: boolean;
  }): Promise<ServiceCategoryView[]> {
    return this.catalogue.listServiceCategories(options);
  }

  /**
   * BI-185, BI-186. A new category with its kind. A repeated name is refused
   * by `billable_service_category_name_unique`, not by a read first.
   */
  async createCategory(
    category: { name: string; kind: ServiceCategoryKind },
    requester: Requester,
  ): Promise<ServiceCategoryView> {
    const created = await this.catalogue.createServiceCategory(category);
    await this.recordChange(created.id, 'CREATE', requester, CATEGORY_RESOURCE_TYPE); // prettier-ignore
    return created;
  }

  /**
   * BI-185. Renames or (de)activates. The kind is not editable: a category
   * whose consultations became supplies would turn every tie BI-187 guards
   * into a mismatch at once.
   */
  async updateCategory(
    categoryId: string,
    update: { name?: string; active?: boolean },
    requester: Requester,
  ): Promise<ServiceCategoryView> {
    const existing = await this.catalogue.findServiceCategory(categoryId);
    if (!existing) throw new ServiceCategoryNotFoundError();
    const updated = await this.catalogue.updateServiceCategory(categoryId, update); // prettier-ignore
    await this.recordChange(categoryId, 'UPDATE', requester, CATEGORY_RESOURCE_TYPE); // prettier-ignore
    return updated;
  }

  /** BI-185. A category a service may take now: it exists and is active. */
  private async requireActiveCategory(
    categoryId: string,
  ): Promise<ServiceCategoryView> {
    const category = await this.catalogue.findServiceCategory(categoryId);
    if (!category) throw new ServiceCategoryNotFoundError();
    if (!category.active) throw new ServiceCategoryInactiveError();
    return category;
  }

  /** The service, or `BillableServiceNotFoundError`. */
  private async requireService(
    serviceId: string,
  ): Promise<BillableServiceView> {
    const service = await this.catalogue.findBillableService(serviceId);
    if (!service) throw new BillableServiceNotFoundError();
    return service;
  }

  /**
   * BI-013. A service may only point at a tax rate that exists; checked before
   * the write so the answer is a named error rather than a foreign-key failure.
   */
  private async requireTaxRate(taxRateId: string): Promise<TaxRateView> {
    const rate = await this.catalogue.findTaxRate(taxRateId);
    if (!rate) throw new TaxRateNotFoundError();
    return rate;
  }

  /** BI-046, BI-132. Who, what, when and from where — for every change. */
  private async recordChange(
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    requester: Requester,
    resourceType: string = SERVICE_RESOURCE_TYPE,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}

/**
 * BI-187. What a category's kind admits: only a consultation is the
 * consultation of a specialty (BI-158), and only a procedure is tied to a
 * procedure concept (BI-151). Checked on the service AS IT WILL BE after the
 * update, so moving a mapped consultation into «Insumos» is refused as surely
 * as mapping a glove.
 */
function assertKindAdmits(
  kind: ServiceCategoryKind,
  ties: { consultation: boolean; procedure: boolean },
): void {
  if (ties.consultation && kind !== 'CONSULTATION') {
    throw new ServiceKindMismatchError();
  }
  if (ties.procedure && kind !== 'PROCEDURE') {
    throw new ServiceKindMismatchError();
  }
}
