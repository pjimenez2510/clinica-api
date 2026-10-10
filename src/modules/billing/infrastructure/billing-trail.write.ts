import type { Prisma } from '@prisma/client';

import type { BillingTrail } from '../domain/billing-trail';

/** `access_audit.user_agent` is a `varchar(512)`. */
const MAX_USER_AGENT = 512;

/**
 * BI-132, BI-273. The issuance's entry, INSIDE the caller's transaction: it
 * commits with the document or not at all. A refusal here aborts the
 * issuance, which is the point — the same choice `MFA_RESET` (AU-035) and
 * EN-075 made.
 *
 * No `before`/`after`: an invoice carries the buyer's identification, and
 * `access_audit` is never purged (BI-007).
 */
export async function writeBillingTrail(
  tx: Prisma.TransactionClient,
  entry: {
    resourceType: 'invoice' | 'credit_note';
    resourceId: string;
    action: 'CREATE' | 'UPDATE';
    trail: BillingTrail;
  },
): Promise<void> {
  await tx.accessAudit.create({
    data: {
      userId: entry.trail.userId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: entry.action,
      ip: entry.trail.ip,
      userAgent: entry.trail.userAgent?.slice(0, MAX_USER_AGENT),
    },
  });
}
