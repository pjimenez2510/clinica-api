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
  TaxReviewRateChangedError,
  ServiceNamedElsewhereError,
  ServiceConsentTieLockedError,
  ServiceNotAProcedureError,
  ServiceProcedureNotInTariffError,
  ServiceProcedureTakenError,
  ServiceTariffCodeFromProcedureError,
} from '../domain/billing.errors';

import {
  type BillingChange,
  billableServiceSnapshot,
  serviceCategorySnapshot,
} from './billing-audit.snapshots';

/** Who is asking, for the trail BI-046 and BI-132 demand. */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * `access_audit.resource_type` for the two things this service changes.
 *
 * Both carry `before`/`after` since `admin_edit_in_place` widened
 * `access_audit_payload_only_for_declared_resources` to them (BI-231, D-150).
 * Until then they could not: a failure to record does not throw, so a row with
 * a payload on a resource type outside the whitelist would have been silently
 * LOST. Whoever adds a resource type here checks that list first.
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
    await this.recordChange(
      created.id,
      'CREATE',
      requester,
      SERVICE_RESOURCE_TYPE,
      {
        after: billableServiceSnapshot(created),
      },
    );
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
    // ORD-163, SP-030 (D-179). What an exam or a service type names is
    // corrected there, once: never here behind its back.
    const renames = update.name !== undefined && update.name !== current.name;
    const retariffs =
      update.tariffCode !== undefined &&
      update.tariffCode !== current.tariffCode;
    // BI-257. The procedure it charges, from the tariff and only on a
    // procedure-kind service; a service carrying the 024 mark (BI-256) keeps
    // it, or the mark would point at nothing.
    const retiesProcedure =
      update.procedureConceptId !== undefined &&
      update.procedureConceptId !== (current.procedureConcept?.id ?? null);
    const tiesProcedure = retiesProcedure && update.procedureConceptId !== null;
    // D-179. Tied, the tariff code IS its procedure's: written by tying,
    // never apart (`billable_service_tariff_code_is_its_procedure`).
    if (retariffs && !retiesProcedure && current.procedureConcept !== null) {
      throw new ServiceTariffCodeFromProcedureError();
    }
    if (renames || retariffs || tiesProcedure) {
      const owned =
        current.serviceTypes.length > 0 ||
        (await this.catalogue.listExamsOfService(serviceId)).length > 0;
      if (owned) throw new ServiceNamedElsewhereError();
    }
    if (update.taxRateId !== undefined) {
      if (!update.taxRateId) throw new TaxRateRequiredError();
      await this.requireTaxRate(update.taxRateId);
    }
    // BI-187 is checked only when the update touches what it guards — the
    // category. A service already out of step (a
    // migrated «Consulta externa» left as OTHER) can still be renamed,
    // re-rated or deactivated: correcting is always possible.
    const movesCategory =
      update.categoryId !== undefined &&
      update.categoryId !== current.category.id;
    let tied: BillableServiceUpdate = update;
    if (retiesProcedure) {
      // D-199.1. Moving the tie would move the medical direction's mark.
      if (current.writtenConsent.required) {
        throw new ServiceConsentTieLockedError();
      }
      if (update.procedureConceptId !== null) {
        const conceptId = update.procedureConceptId!;
        const code = await this.catalogue.tariffConceptCode(conceptId);
        if (code === null) throw new ServiceProcedureNotInTariffError();
        if (await this.catalogue.procedureTakenByOther(conceptId, serviceId)) {
          throw new ServiceProcedureTakenError();
        }
        // D-179. Tying writes the code: the one typed before is replaced
        // (the old one stays in the trail's `before`), never asked twice.
        tied = { ...update, tariffCode: code };
      }
    }
    if (movesCategory || retiesProcedure) {
      const category = movesCategory
        ? await this.requireActiveCategory(update.categoryId!)
        : current.category;
      const tiedProcedure = retiesProcedure
        ? update.procedureConceptId !== null
        : current.procedureConcept !== null;
      assertKindAdmits(category.kind, {
        consultations: current.serviceTypes.length,
        procedures: Number(tiedProcedure),
        examCategories: (
          await this.catalogue.listExamsOfService(serviceId)
        ).map((exam) => exam.category),
      });
    }

    // D-172.2. A new rate is nobody's review yet; the old review stays in the
    // trail through the `before` snapshot. The same rate saved again is not
    // a change, and renaming touches no review at all.
    const changesRate =
      update.taxRateId !== undefined && update.taxRateId !== current.taxRateId;
    const updated = await this.catalogue.updateBillableService(
      serviceId,
      changesRate ? { ...tied, taxReview: null } : tied,
    );
    await this.recordChange(
      serviceId,
      'UPDATE',
      requester,
      SERVICE_RESOURCE_TYPE,
      {
        before: billableServiceSnapshot(current),
        after: billableServiceSnapshot(updated),
      },
    );
    return updated;
  }

  /**
   * BI-024. Records that `requester` checked the service's tax rate —THE ONE
   * THEY SAW, `seenTaxRateId`—, now.
   *
   * ⚠️ THE RATE TRAVELS WITH THE REVIEW (D-172). A tab opened on 0 % while
   * somebody else moved the service to 15 % would otherwise sign the 15 %,
   * which its author never looked at; and the write is conditional on that
   * rate, so the same holds when the change lands between this read and the
   * write.
   *
   * THE INSTANT IS THE APPLICATION'S CLOCK, not PostgreSQL's `now()`: it is
   * what every other stamp of this module uses, and what the walks move.
   * Marking it again simply records the newer review; the older one stays in
   * the trail.
   */
  async markTaxReviewed(
    serviceId: string,
    seenTaxRateId: string,
    requester: Requester,
  ): Promise<BillableServiceView> {
    const current = await this.requireService(serviceId);
    if (current.taxRateId !== seenTaxRateId) {
      throw new TaxReviewRateChangedError();
    }
    const updated = await this.catalogue.markTaxReviewed(
      serviceId,
      seenTaxRateId,
      { reviewedAt: new Date(), reviewedById: requester.userId },
    );
    if (updated === null) throw new TaxReviewRateChangedError();
    await this.recordChange(
      serviceId,
      'UPDATE',
      requester,
      SERVICE_RESOURCE_TYPE,
      {
        before: billableServiceSnapshot(current),
        after: billableServiceSnapshot(updated),
      },
    );
    return updated;
  }

  /**
   * BI-256 (D-159.1, .5). Marks or unmarks the service as demanding the
   * signed form 024 for its procedure (EN-152), with who and when — the
   * application's clock — and the trail of the row before and after.
   *
   * ⚠️ `record:consent-rule`, NOT `billing:price-manage`: the mark is a
   * clinical decision of the medical direction that lives on the economic
   * sheet only because that is where the clinic describes what it performs.
   * Setting it to what it already is records nothing.
   */
  async markWrittenConsent(
    serviceId: string,
    required: boolean,
    requester: Requester,
  ): Promise<BillableServiceView> {
    const current = await this.requireService(serviceId);
    if (required && current.procedureConcept === null) {
      throw new ServiceNotAProcedureError();
    }
    if (current.writtenConsent.required === required) return current;

    const updated = await this.catalogue.updateBillableService(serviceId, {
      writtenConsent: {
        required,
        setAt: new Date(),
        setById: requester.userId,
      },
    });
    await this.recordChange(
      serviceId,
      'UPDATE',
      requester,
      SERVICE_RESOURCE_TYPE,
      {
        before: billableServiceSnapshot(current),
        after: billableServiceSnapshot(updated),
      },
    );
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
    const current = await this.requireService(serviceId);
    // D-199.1. Deleting it would remove the mark with a price manager's key.
    if (current.writtenConsent.required) {
      throw new ServiceConsentTieLockedError();
    }

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
    await this.recordChange(
      created.id,
      'CREATE',
      requester,
      CATEGORY_RESOURCE_TYPE,
      {
        after: serviceCategorySnapshot(created),
      },
    );
    return created;
  }

  /**
   * BI-185, BI-187. Renames, (de)activates or reclassifies — the last only
   * while every service of the category keeps a tie its new kind admits.
   */
  async updateCategory(
    categoryId: string,
    update: { name?: string; active?: boolean; kind?: ServiceCategoryKind },
    requester: Requester,
  ): Promise<ServiceCategoryView> {
    const existing = await this.catalogue.findServiceCategory(categoryId);
    if (!existing) throw new ServiceCategoryNotFoundError();
    // BI-187. A category is reclassified only when none of its services has a
    // tie the new kind does not admit — the way out for the OTHER categories
    // the migration left.
    if (update.kind !== undefined && update.kind !== existing.kind) {
      assertKindAdmits(
        update.kind,
        await this.catalogue.countCategoryTies(categoryId),
      );
    }
    const updated = await this.catalogue.updateServiceCategory(categoryId, update); // prettier-ignore
    await this.recordChange(
      categoryId,
      'UPDATE',
      requester,
      CATEGORY_RESOURCE_TYPE,
      {
        before: serviceCategorySnapshot(existing),
        after: serviceCategorySnapshot(updated),
      },
    );
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
    change: BillingChange = {},
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
      // BI-231. Plain copies of the snapshots in `billing-audit.snapshots.ts`.
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
    });
  }
}

/**
 * BI-187. What a category's kind admits: only a consultation is the
 * consultation of a specialty (BI-158), only a procedure is tied to a
 * procedure concept, and an exam is charged through a service of ITS OWN
 * type —laboratory, imaging or procedure— (BI-151, ORD-108). Checked on the service AS IT WILL BE after the
 * update, so moving a mapped consultation into «Insumos» is refused as surely
 * as mapping a glove.
 */
function assertKindAdmits(
  kind: ServiceCategoryKind,
  ties: {
    consultations: number;
    procedures: number;
    examCategories: readonly string[];
  },
): void {
  if (ties.consultations > 0 && kind !== 'CONSULTATION') {
    throw new ServiceKindMismatchError();
  }
  if (ties.procedures > 0 && kind !== 'PROCEDURE') {
    throw new ServiceKindMismatchError();
  }
  if (ties.examCategories.some((category) => category !== kind)) {
    throw new ServiceKindMismatchError();
  }
}
