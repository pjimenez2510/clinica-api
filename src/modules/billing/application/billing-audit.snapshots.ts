import type { PayerView, ServiceView } from '../domain/billing.repository';
import type { PriceRow } from '../domain/price-list';

/**
 * BI-231, D-150. What the billing catalogue's trail says a mutation replaced
 * and what it left: the EDITABLE fields of each domain view, picked one by one.
 *
 * Picked rather than spread for two reasons. A view carries nested and derived
 * values — the specialty's name, the tax rate's code and percentage read
 * through a join — that are not what anybody edited. And `Money` and
 * `Percentage` hold `bigint`s, which `JSON.stringify` refuses outright: a
 * snapshot that carried one would make the audit INSERT fail, and since a
 * failure to record does not throw, the entry would simply be lost. Amounts
 * travel as their decimal string, the same form they cross every other
 * boundary in.
 *
 * `access_audit_payload_only_for_declared_resources` admits a payload on
 * `service`, `price` and `payer` (`service_catalogue`, BI-290).
 */
export interface BillingChange {
  before?: Readonly<object>;
  after?: Readonly<object>;
}

/** BI-231, BI-290. A service's editable fields, its extension included. */
export function serviceSnapshot(view: ServiceView): object {
  return {
    code: view.code,
    name: view.name,
    kind: view.kind,
    mspCode: view.mspCode,
    taxRateId: view.taxRateId,
    active: view.active,
    specialtyId: view.consultation?.specialtyId ?? null,
    durationMinutes: view.consultation?.durationMinutes ?? null,
    visitKind: view.consultation?.visitKind ?? null,
    exam: view.exam === null ? null : { ...view.exam },
    // BI-024. The review travels with the row, so the one a rate change
    // clears is still readable here: who checked which rate, and when.
    taxReviewedAt: view.taxReview?.reviewedAt.toISOString() ?? null,
    taxReviewedById: view.taxReview?.reviewedById ?? null,
    // BI-256. Its 024 mark, with who.
    requiresWrittenConsent: view.writtenConsent.required,
    writtenConsentSetById: view.writtenConsent.setById,
  };
}

/** BI-231. A payer's fields; `code` and `kind` name it to the reader. */
export function payerSnapshot(view: PayerView): object {
  return {
    code: view.code,
    name: view.name,
    kind: view.kind,
    ruc: view.ruc,
    agreementReference: view.agreementReference,
    active: view.active,
  };
}

/** BI-231. A price: the amount as its decimal string, and its validity. */
export function priceSnapshot(row: PriceRow): object {
  return {
    serviceId: row.serviceId,
    amount: row.amount.toString(),
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}
