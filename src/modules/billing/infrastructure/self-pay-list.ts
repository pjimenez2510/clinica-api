import type { Prisma } from '@prisma/client';

/**
 * BI-040, BI-280. The self-pay list (`payer.kind = 'SELF_PAY'`), the
 * clinic-wide one: the list a new service gets its first price in, the one the
 * public tariff publishes (BI-111) and the one an account defaults to.
 */
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
