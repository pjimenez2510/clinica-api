import { Prisma } from '@prisma/client';

/**
 * BI-103. THE balance of an invoice, in SQL, in ONE place: its total, less its
 * credit notes the SRI did not reject, less its payments not reversed.
 * Derived on every read and never stored.
 *
 * It was written out three times —the patient's balance, the turn's pending
 * and «Con saldo»— and three copies of a sum diverge the first time one of
 * them learns a new rule. The TypeScript twin over a read invoice is
 * `invoiceBalance` in `domain/cash.ts`.
 *
 * ⚠️ THE INVOICE MUST BE ALIASED `i` in the query that interpolates these.
 */
export const INVOICE_BALANCE = Prisma.sql`(
  i."total"
  - COALESCE((SELECT SUM(c."amount") FROM "credit_note" c
               WHERE c."invoice_id" = i."id" AND c."status" NOT IN ('REJECTED', 'WITHDRAWN')), 0)
  - COALESCE((SELECT SUM(p."amount") FROM "payment" p
               WHERE p."invoice_id" = i."id" AND p."reversed_at" IS NULL), 0)
)`;

/**
 * BI-103. The invoices a balance counts — owed or in the patient's favour: a
 * draft is not a document yet, and a voided one owes nothing.
 */
export const INVOICE_COUNTS_TOWARD_BALANCE = Prisma.sql`i."status" NOT IN ('DRAFT', 'VOIDED')`;
