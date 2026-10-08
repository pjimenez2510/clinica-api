import type {
  BillableServiceView,
  PayerView,
  ServiceCategoryView,
} from '../domain/billing.repository';
import type { PriceRow } from '../domain/price-list';

/**
 * BI-231, D-150. What the billing catalogue's trail says a mutation replaced
 * and what it left: the EDITABLE fields of each domain view, picked one by one.
 *
 * Picked rather than spread for two reasons. A view carries nested and derived
 * values — the category object, the tax rate's code and percentage read
 * through a join — that are not what anybody edited. And `Money` and
 * `Percentage` hold `bigint`s, which `JSON.stringify` refuses outright: a
 * snapshot that carried one would make the audit INSERT fail, and since a
 * failure to record does not throw, the entry would simply be lost. Amounts
 * travel as their decimal string, the same form they cross every other
 * boundary in.
 *
 * `access_audit_payload_only_for_declared_resources` admits a payload on
 * `billable_service`, `billable_service_category`, `price` and `payer` since
 * `admin_edit_in_place`.
 */
export interface BillingChange {
  before?: Readonly<object>;
  after?: Readonly<object>;
}

/** BI-231. A billable service's editable fields (BI-011). */
export function billableServiceSnapshot(view: BillableServiceView): object {
  return {
    code: view.code,
    name: view.name,
    categoryId: view.category.id,
    tariffCode: view.tariffCode,
    taxRateId: view.taxRateId,
    active: view.active,
    // BI-024. The review travels with the row, so the one a rate change
    // clears is still readable here: who checked which rate, and when.
    taxReviewedAt: view.taxReview?.reviewedAt.toISOString() ?? null,
    taxReviewedById: view.taxReview?.reviewedById ?? null,
  };
}

/** BI-231. A category's editable fields (BI-185). */
export function serviceCategorySnapshot(view: ServiceCategoryView): object {
  return { name: view.name, kind: view.kind, active: view.active };
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
    billableServiceId: row.billableServiceId,
    amount: row.amount.toString(),
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}
