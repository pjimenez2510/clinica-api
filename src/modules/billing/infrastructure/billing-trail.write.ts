import { isIP } from 'node:net';

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
      ip: addressOrNull(entry.trail.ip),
      userAgent: entry.trail.userAgent?.slice(0, MAX_USER_AGENT),
    },
  });
}

/**
 * `access_audit.ip` is an `inet`, which knows no IPv6 zone (`fe80::1%en0`)
 * although Node's `isIP` accepts one: the zone names a local interface, not
 * the client, and is dropped. Anything else that is not an address (a forged
 * forwarded header) must not cost the clinic the invoice: the entry keeps who
 * and what, and loses only where from. Never logged — the address is
 * personal data (LOPDP).
 */
function addressOrNull(ip: string | undefined): string | null {
  const address = ip?.split('%')[0];
  return address !== undefined && isIP(address) !== 0 ? address : null;
}
