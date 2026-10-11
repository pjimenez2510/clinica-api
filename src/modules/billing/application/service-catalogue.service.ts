import { Inject, Injectable } from '@nestjs/common';

import {
  type ClinicalDate,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import {
  assertDurationFitsSlotAtom,
  clinicSlotAtom,
} from '../../../shared/domain/slot-atom';
import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  BILLING_CATALOGUE_REPOSITORY,
  type BillingCatalogueRepository,
  type ConsultationData,
  type OrderExtension,
  type ServiceAnalyteView,
  type ServiceKind,
  type ServicePage,
  type ServicePriceView,
  type ServiceUpdate,
  type ServiceView,
  type TaxRateView,
  type VisitKind,
  isOrderableKind,
} from '../domain/billing.repository';
import { Money } from '../domain/money';
import { isInForceOn } from '../domain/price-list';
import { CODE_PREFIXES, proposeServiceCode } from '../domain/service-code';
import {
  BillableServiceInUseError,
  BillableServiceNotFoundError,
  ConsultationDuplicateError,
  ConsultationIncompleteError,
  PriceListNotFoundError,
  ServiceCodeInvoicedError,
  ServiceCodeOrderedError,
  ServiceConsentTieLockedError,
  ServiceKindMismatchError,
  ServiceNotAProcedureError,
  ServiceProcedureNotInTariffError,
  ServiceProcedureTakenError,
  ServiceTariffCodeInvoicedError,
  TaxRateNotFoundError,
  TaxRateRequiredError,
  TaxReviewRateChangedError,
} from '../domain/billing.errors';

import { type BillingChange, serviceSnapshot } from './billing-audit.snapshots';

/** Who is asking, for the trail BI-046 and BI-132 demand. */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * `access_audit.resource_type` of what this service changes (BI-290). It
 * carries `before`/`after` since `service_catalogue` widened
 * `access_audit_payload_only_for_declared_resources` to it. A failure to
 * record does not throw, so a payload on a resource type outside that list
 * would be silently LOST: whoever adds one here checks that list first.
 */
const SERVICE_RESOURCE_TYPE = 'service';

/** BI-280. A new service, as the screen asks for it: kind first. */
export interface NewServiceRequest {
  kind: ServiceKind;
  code?: string;
  name: string;
  /** D-228. Required; zero is a price. */
  selfPayAmount: Money;
  mspCode: string | null;
  taxRateId?: string;
  specialtyId?: string;
  durationMinutes?: number;
  visitKind?: VisitKind | null;
  exam?: Partial<OrderExtension> | null;
}

/** A partial correction; the kind is not here (BI-278). */
export interface ServiceCorrection {
  code?: string;
  name?: string;
  mspCode?: string | null;
  taxRateId?: string;
  active?: boolean;
  specialtyId?: string;
  durationMinutes?: number;
  visitKind?: VisitKind | null;
  exam?: Partial<OrderExtension> | null;
}

/** BI-283. A service with its analytes and its prices. */
export interface ServiceDetail extends ServiceView {
  analytes: ServiceAnalyteView[];
  prices: (ServicePriceView & { inForce: boolean })[];
}

/** The extension's defaults: those of `service_exam` (D-A-012). */
const EXTENSION_DEFAULTS: OrderExtension = {
  form010Section: null,
  specimenType: null,
  patientPreparation: null,
  turnaroundHours: null,
  requiresFasting: false,
  fastingHours: null,
  performedExternally: true,
  externalLabName: null,
  externalLabCode: null,
};

/**
 * ONE CATALOGUE OF WHAT THE CLINIC OFFERS AND CHARGES (ADR-013) — WITHOUT A
 * PRICE ON IT.
 *
 * ⚠️ BI-006 STILL HOLDS. The price is a row of a price list, never a column of
 * the service: it breaks the first day an insurer pays differently. Creating
 * a service writes its FIRST self-pay price in the same transaction (BI-280,
 * D-228) — the one the author believed missing when an exam was created
 * without it — and every later change is `PricingService`'s (BI-044, BI-230).
 *
 * The kind decides what the service carries (BI-278): a consultation, its
 * specialty, duration and visit (BI-279); an exam, an imaging study or a
 * procedure that is ordered, its order extension (BI-284); a procedure, its
 * tariff code (BI-286). Those rules live HERE and not in the DTO, and the
 * database keeps them again underneath (`service_consultation_shape`,
 * `trg_service_exam_kind_admits`, `service_one_procedure_per_code`).
 *
 * SEPARATE FROM `PricingService` for the third of ADR-008 §2's limits: the
 * two change for different reasons — one when the clinic learns to do
 * something new, the other when it charges differently for what it already
 * does.
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
   * BI-020, BI-021. The SRI's rates, as rows and with their validity: 12% and
   * 14% existed, and a 2016 invoice has to be readable.
   */
  async listTaxRates(): Promise<TaxRateView[]> {
    return this.catalogue.listTaxRates();
  }

  /**
   * BI-282 (D-220 §3). One page of the catalogue, filtered in the database,
   * each row with its prices in force on `today` in every active list.
   */
  async listServices(filter: {
    query: string | null;
    kind: ServiceKind | null;
    specialtyId: string | null;
    includeInactive: boolean;
    forTaxReview: boolean;
    page: number;
    pageSize: number;
    today: ClinicalDate;
  }): Promise<ServicePage> {
    return this.catalogue.listServices(filter);
  }

  /** BI-283. The service's card in one answer. */
  async serviceDetail(
    serviceId: string,
    today: ClinicalDate,
  ): Promise<ServiceDetail> {
    const service = await this.requireService(serviceId);
    const [analytes, prices] = await Promise.all([
      service.exam === null
        ? Promise.resolve([])
        : this.catalogue.listAnalytesOfService(serviceId),
      this.catalogue.listPricesAcrossPayers(serviceId),
    ]);
    return {
      ...service,
      analytes,
      prices: prices.map((price) => ({
        ...price,
        inForce: isInForceOn(price, today),
      })),
    };
  }

  /**
   * BI-280. Creates a service with its first self-pay price —and, if it is
   * ordered, its extension— in one transaction.
   *
   * ⚠️ THE RATE IS NOT INFERRED FROM ANYTHING (BI-005, D-A-006). When none is
   * sent, the health-services rate (code `0`) is taken AS A DEFAULT and born
   * unreviewed: art. 191 of the LRTI regulation excludes cosmetic work from
   * the 0%, and that judgement is a person's, recorded as the tax review.
   *
   * The unicity of `code` and of the active name is NOT read first:
   * `service_code_unique` and `service_active_name_unique` are the guarantee.
   */
  async createService(
    request: NewServiceRequest,
    requester: Requester,
  ): Promise<ServiceView> {
    const consultation = await this.consultationOf(request.kind, {
      specialtyId: request.specialtyId,
      durationMinutes: request.durationMinutes,
      visitKind: request.visitKind,
    });
    if (consultation !== null) await this.assertNoTwin(consultation, null);
    const exam = this.extensionOf(request.kind, request.exam);
    const mspCode = normalised(request.mspCode);
    if (request.kind === 'PROCEDURE' && mspCode !== null) {
      await this.assertProcedureCode(mspCode, null);
    }

    const taxRate =
      request.taxRateId === undefined
        ? await this.catalogue.findHealthTaxRate()
        : await this.requireTaxRate(request.taxRateId);
    if (taxRate === null) throw new TaxRateRequiredError();

    const selfPay = await this.catalogue.findSelfPayPriceList();
    if (selfPay === null) throw new PriceListNotFoundError();

    const code =
      normalised(request.code) ??
      proposeServiceCode(
        request.kind,
        request.name,
        new Set(
          await this.catalogue.codesStartingWith(CODE_PREFIXES[request.kind]),
        ),
      );

    const created = await this.catalogue.createService({
      code,
      name: request.name,
      kind: request.kind,
      mspCode,
      taxRateId: taxRate.id,
      consultation,
      exam,
      selfPay: {
        priceListId: selfPay.id,
        amount: request.selfPayAmount,
        validFrom: clinicalDateOf(new Date()),
      },
    });
    await this.recordChange(created.id, 'CREATE', requester, {
      after: serviceSnapshot(created),
    });
    return created;
  }

  /**
   * BI-279, BI-281, BI-284 to BI-286, BI-025. Corrects a service.
   *
   * ⚠️ CHANGING THE RATE CHANGES NOTHING ALREADY CHARGED (BI-025): every
   * charge froze `tax_sri_code` and `tax_percentage` the day it was raised.
   * ⚠️ AND THE CODES DO NOT MOVE ONCE THEY ARE ON PAPER (BI-281, BI-285): the
   * RIDE reprints the service's code and MSP code, and an order line froze
   * its code.
   */
  async updateService(
    serviceId: string,
    correction: ServiceCorrection,
    requester: Requester,
  ): Promise<ServiceView> {
    const current = await this.requireService(serviceId);
    const update: ServiceUpdate = {
      name: correction.name,
      taxRateId: correction.taxRateId,
      active: correction.active,
    };

    const code = normalised(correction.code);
    if (code !== null && code !== current.code) {
      if (await this.catalogue.hasInvoicedCharges(serviceId)) {
        throw new ServiceCodeInvoicedError();
      }
      if (await this.catalogue.codeWasOrdered(current.code)) {
        throw new ServiceCodeOrderedError();
      }
      update.code = code;
    }

    if (correction.mspCode !== undefined) {
      const mspCode = normalised(correction.mspCode);
      if (mspCode !== current.mspCode) {
        // D-199.1. Moving the code would move the medical direction's mark.
        if (current.writtenConsent.required) {
          throw new ServiceConsentTieLockedError();
        }
        if (current.kind === 'PROCEDURE' && mspCode !== null) {
          await this.assertProcedureCode(mspCode, serviceId);
        }
        if (await this.catalogue.hasInvoicedCharges(serviceId)) {
          throw new ServiceTariffCodeInvoicedError();
        }
        update.mspCode = mspCode;
      }
    }

    // Only what CHANGES is validated again: the form sends the three fields on
    // every correction, and renaming a consultation must not fail because its
    // specialty was deactivated or a site's slot size changed since.
    const was = current.consultation;
    const touchesConsultation =
      (correction.specialtyId !== undefined &&
        correction.specialtyId !== was?.specialtyId) ||
      (correction.durationMinutes !== undefined &&
        correction.durationMinutes !== was?.durationMinutes) ||
      (correction.visitKind !== undefined &&
        (correction.visitKind ?? null) !== (was?.visitKind ?? null));
    let corrected: ConsultationData | null = null;
    if (touchesConsultation) {
      if (current.consultation === null) {
        throw new ServiceKindMismatchError('specialtyId');
      }
      corrected = await this.consultationOf('CONSULTATION', {
        specialtyId: correction.specialtyId ?? current.consultation.specialtyId,
        durationMinutes:
          correction.durationMinutes ?? current.consultation.durationMinutes,
        visitKind:
          correction.visitKind === undefined
            ? current.consultation.visitKind
            : correction.visitKind,
      });
      update.consultation = corrected ?? undefined;
    }
    // BI-298. A changed specialty or visit, or a consultation coming back.
    const reactivated = correction.active === true && !current.active;
    if (current.consultation !== null && (corrected !== null || reactivated)) {
      await this.assertNoTwin(corrected ?? current.consultation, serviceId);
    }

    if (correction.exam !== undefined) {
      if (correction.exam === null) {
        // BI-284. Only a procedure stops being ordered; an exam IS ordered.
        if (current.kind !== 'PROCEDURE') {
          throw new ServiceKindMismatchError('exam');
        }
        // Its order lines resolve their structure and turnaround through it.
        if (
          current.exam !== null &&
          (await this.catalogue.codeWasOrdered(current.code))
        ) {
          throw new ServiceCodeOrderedError('exam');
        }
        update.exam = null;
      } else {
        if (!isOrderableKind(current.kind)) {
          throw new ServiceKindMismatchError('exam');
        }
        update.exam = stripUndefined(correction.exam);
      }
    }

    if (correction.taxRateId !== undefined) {
      if (!correction.taxRateId) throw new TaxRateRequiredError();
      await this.requireTaxRate(correction.taxRateId);
    }
    // D-172.2. A new rate is nobody's review yet; the old review stays in the
    // trail through the `before` snapshot.
    const changesRate =
      correction.taxRateId !== undefined &&
      correction.taxRateId !== current.taxRateId;

    const updated = await this.catalogue.updateService(
      serviceId,
      changesRate ? { ...update, taxReview: null } : update,
    );
    await this.recordChange(serviceId, 'UPDATE', requester, {
      before: serviceSnapshot(current),
      after: serviceSnapshot(updated),
    });
    return updated;
  }

  /**
   * BI-024. Records that `requester` checked the service's tax rate —THE ONE
   * THEY SAW, `seenTaxRateId`—, now. The write is conditional on that rate,
   * so a change landing between this read and the write signs nothing.
   */
  async markTaxReviewed(
    serviceId: string,
    seenTaxRateId: string,
    requester: Requester,
  ): Promise<ServiceView> {
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
    await this.recordChange(serviceId, 'UPDATE', requester, {
      before: serviceSnapshot(current),
      after: serviceSnapshot(updated),
    });
    return updated;
  }

  /**
   * BI-256 (D-159.1, .5). Marks or unmarks the service as demanding the
   * signed form 024 for its procedure (EN-152), with who and when.
   *
   * ⚠️ `record:consent-rule`, NOT `billing:price-manage`: the mark is a
   * clinical decision of the medical direction that lives on the service only
   * because that is where the clinic describes what it performs.
   */
  async markWrittenConsent(
    serviceId: string,
    required: boolean,
    requester: Requester,
  ): Promise<ServiceView> {
    const current = await this.requireService(serviceId);
    if (
      required &&
      (current.kind !== 'PROCEDURE' || current.mspCode === null)
    ) {
      throw new ServiceNotAProcedureError();
    }
    if (current.writtenConsent.required === required) return current;

    const updated = await this.catalogue.updateService(serviceId, {
      writtenConsent: {
        required,
        setAt: new Date(),
        setById: requester.userId,
      },
    });
    await this.recordChange(serviceId, 'UPDATE', requester, {
      before: serviceSnapshot(current),
      after: serviceSnapshot(updated),
    });
    return updated;
  }

  /**
   * BI-012, BI-288. Refuses to delete a service anything references, and
   * says so: the service an eight-month-old invoice, an appointment or an
   * order names has to keep existing for them to be readable.
   */
  async deleteService(
    serviceId: string,
    requester: Requester,
    requireOrderKey: () => void,
  ): Promise<void> {
    const current = await this.requireService(serviceId);
    // BI-299. That key alone does not remove what the order prints; asked
    // first, so a refused caller learns nothing more of the service.
    if (current.exam !== null) requireOrderKey();
    // D-199.1. Deleting it would remove the mark with a price manager's key.
    if (current.writtenConsent.required) {
      throw new ServiceConsentTieLockedError();
    }
    const references = await this.catalogue.countReferencesToService(serviceId);
    if (references > 0) throw new BillableServiceInUseError();

    await this.catalogue.deleteService(serviceId);
    await this.recordChange(serviceId, 'UPDATE', requester, {
      before: serviceSnapshot(current),
    });
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

  /**
   * BI-279. A consultation's agenda data, complete and valid; `null` for any
   * other kind, which may not carry them.
   *
   * SP-021. The duration fits the slot atom of EVERY site —the consultation
   * has no site—, and the specialty is active.
   */
  /** BI-298. One active consultation per specialty and visit. */
  private async assertNoTwin(
    consultation: { specialtyId: string; visitKind: VisitKind | null },
    exceptId: string | null,
  ): Promise<void> {
    const twin = await this.catalogue.findActiveConsultation(
      consultation.specialtyId,
      consultation.visitKind,
      exceptId,
    );
    if (twin !== null) {
      throw new ConsultationDuplicateError(twin.specialtyName, consultation.visitKind); // prettier-ignore
    }
  }

  private async consultationOf(
    kind: ServiceKind,
    data: {
      specialtyId?: string;
      durationMinutes?: number;
      visitKind?: VisitKind | null;
    },
  ): Promise<ConsultationData | null> {
    if (kind !== 'CONSULTATION') {
      if (
        data.specialtyId !== undefined ||
        data.durationMinutes !== undefined
      ) {
        throw new ServiceKindMismatchError('specialtyId');
      }
      if (data.visitKind !== undefined && data.visitKind !== null) {
        throw new ServiceKindMismatchError('visitKind');
      }
      return null;
    }
    if (data.specialtyId === undefined) {
      throw new ConsultationIncompleteError('specialtyId');
    }
    if (data.durationMinutes === undefined) {
      throw new ConsultationIncompleteError('durationMinutes');
    }
    if (!(await this.catalogue.specialtyIsActive(data.specialtyId))) {
      throw new ConsultationIncompleteError('specialtyId');
    }
    assertDurationFitsSlotAtom(
      'durationMinutes',
      data.durationMinutes,
      clinicSlotAtom(await this.catalogue.siteSlotAtoms()),
    );
    return {
      specialtyId: data.specialtyId,
      durationMinutes: data.durationMinutes,
      visitKind: data.visitKind ?? null,
    };
  }

  /**
   * BI-284. The order extension of a new service: always on an exam or an
   * imaging study (they ARE ordered), on a procedure only when sent, and
   * never on anything else.
   */
  private extensionOf(
    kind: ServiceKind,
    exam: Partial<OrderExtension> | null | undefined,
  ): OrderExtension | null {
    if (!isOrderableKind(kind)) {
      if (exam !== undefined && exam !== null) {
        throw new ServiceKindMismatchError('exam');
      }
      return null;
    }
    if (kind === 'PROCEDURE' && (exam === undefined || exam === null)) {
      return null;
    }
    // ORD-129. Hours without a fast are refused underneath
    // (`service_exam_fasting_hours_needs_fasting`).
    return { ...EXTENSION_DEFAULTS, ...stripUndefined(exam ?? {}) };
  }

  /**
   * BI-286. A procedure's code is a code of the tariff, and no other active
   * procedure carries it.
   */
  private async assertProcedureCode(
    code: string,
    serviceId: string | null,
  ): Promise<void> {
    if (!(await this.catalogue.isTariffProcedureCode(code))) {
      throw new ServiceProcedureNotInTariffError();
    }
    if (await this.catalogue.procedureCodeTakenByOther(code, serviceId)) {
      throw new ServiceProcedureTakenError();
    }
  }

  /** The service, or `BillableServiceNotFoundError`. */
  private async requireService(serviceId: string): Promise<ServiceView> {
    const service = await this.catalogue.findService(serviceId);
    if (!service) throw new BillableServiceNotFoundError();
    return service;
  }

  /**
   * BI-013. A service may only point at a tax rate that exists; checked
   * before the write so the answer is a named error rather than a
   * foreign-key failure.
   */
  private async requireTaxRate(taxRateId: string): Promise<TaxRateView> {
    const rate = await this.catalogue.findTaxRate(taxRateId);
    if (!rate) throw new TaxRateNotFoundError();
    return rate;
  }

  /** BI-046, BI-132, BI-290. Who, what, when and from where. */
  private async recordChange(
    resourceId: string,
    action: 'CREATE' | 'UPDATE',
    requester: Requester,
    change: BillingChange = {},
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: SERVICE_RESOURCE_TYPE,
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

/** Trimmed text, or `null` for absent or blank. */
function normalised(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

/** The fields actually sent, so a partial update leaves the rest alone. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}
