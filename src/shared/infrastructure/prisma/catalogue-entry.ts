import type { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../domain/clinic-time';

/**
 * D-179. ONE WAY TO WRITE «WHAT IS CHARGED» FOR SOMETHING ANOTHER MODULE OWNS.
 *
 * An exam (`orders`, ORD-162) and a service type (`specialties`, SP-030) are
 * each born with their `billable_service`, IN THE SAME TRANSACTION as the row
 * that owns it: an exam without its service cannot exist any more
 * (`exam_definition.billable_service_id NOT NULL`), and a service type whose
 * service failed would be a consultation caja cannot propose.
 *
 * IN `shared` BECAUSE TWO MODULES WRITE IT and no module imports another, and
 * because two copies of «insert a service and its first price» would be two
 * answers the day a column is added. It takes the caller's transaction client.
 *
 * ⚠️ IT WRITES THE FIRST PRICE ONLY. A brand-new service has no validity to
 * close, so the row opens at `validFrom` with no end. CHANGING a price later
 * is `billing`'s own route (`POST /billing/payers/:id/prices`, BI-041 to
 * BI-048), which closes the old validity — never this.
 *
 * ⚠️ IT DECIDES NO TAX RATE AND NO CATEGORY: the caller passes them. The rate
 * stays UNREVIEWED (`tax_reviewed_at` NULL, D-A-006, BI-024), like the seed's.
 */

/** A new service and, optionally, its price in the self-pay list. */
export interface NewCatalogueEntry {
  code: string;
  name: string;
  categoryId: string;
  taxRateId: string;
  tariffCode: string | null;
  /** Decimal text with two places at most (BI-001), from `validFrom` on. */
  selfPay: { amount: string; validFrom: ClinicalDate } | null;
}

/** The self-pay list (`payer.kind = 'SELF_PAY'`), the clinic-wide one. */
export async function selfPayPriceListId(
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const list = await tx.priceList.findFirst({
    where: { active: true, siteId: null, payer: { kind: 'SELF_PAY', active: true } }, // prettier-ignore
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return list?.id ?? null;
}

/**
 * Inserts the service and its first self-pay price; returns the service id.
 * `billable_service_code_unique` arbitrates a repeated code, and the
 * constraint meaning of `billing` turns it into `BILLABLE_SERVICE_CODE_DUPLICATE`.
 */
export async function createCatalogueEntry(
  tx: Prisma.TransactionClient,
  entry: NewCatalogueEntry,
): Promise<string> {
  const service = await tx.billableService.create({
    data: {
      code: entry.code,
      name: entry.name,
      categoryId: entry.categoryId,
      taxRateId: entry.taxRateId,
      tariffCode: entry.tariffCode,
    },
    select: { id: true },
  });

  if (entry.selfPay !== null) {
    const priceListId = await selfPayPriceListId(tx);
    if (priceListId === null) {
      // Every installation has it: an account cannot be opened without it.
      throw new Error('There is no active self-pay price list');
    }
    await tx.price.create({
      data: {
        priceListId,
        billableServiceId: service.id,
        // A string, never a number: bound straight to `numeric(12,2)`.
        amount: entry.selfPay.amount,
        validFrom: new Date(`${entry.selfPay.validFrom}T00:00:00Z`),
        validTo: null,
      },
    });
  }

  return service.id;
}

/**
 * The self-pay price in force on `on` of each service, as decimal text, for
 * the screens that show «its price» beside the thing that owns the service.
 */
export async function selfPayPricesOn(
  client: Prisma.TransactionClient,
  serviceIds: readonly string[],
  on: ClinicalDate,
): Promise<Map<string, string>> {
  if (serviceIds.length === 0) return new Map();
  const day = new Date(`${on}T00:00:00Z`);
  const rows = await client.price.findMany({
    where: {
      billableServiceId: { in: [...serviceIds] },
      validFrom: { lte: day },
      OR: [{ validTo: null }, { validTo: { gt: day } }],
      priceList: { active: true, siteId: null, payer: { kind: 'SELF_PAY', active: true } }, // prettier-ignore
    },
    orderBy: [{ priceList: { createdAt: 'asc' } }, { validFrom: 'desc' }],
    select: { billableServiceId: true, amount: true },
  });
  const prices = new Map<string, string>();
  for (const row of rows) {
    if (!prices.has(row.billableServiceId)) {
      prices.set(row.billableServiceId, row.amount.toFixed(2));
    }
  }
  return prices;
}
