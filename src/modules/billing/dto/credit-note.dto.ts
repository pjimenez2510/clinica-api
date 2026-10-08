import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CREDIT_NOTE_REASON_CODES } from '../domain/credit-note';
import { BUYER_IDENTIFICATION_TYPES } from '../domain/invoice';

import {
  electronicStateSchema,
  issuedDocumentQueryShape,
  totalsSchema,
} from './billing.dto';

/**
 * BI-208, BI-209. «Corregir»: which lines and why.
 *
 * `chargeIds` absent or empty is «every line not yet credited» (BI-208). The
 * text is only read with «Otro», and its ABSENCE is answered by
 * `CREDIT_NOTE_REASON_REQUIRED` on `reasonText` — a code the client can
 * branch on — rather than by a generic validation failure.
 */
export const issueCreditNoteSchema = z.object({
  // At least one when sent: «every line» is said by leaving it out, never by
  // an empty list a buggy client could send (clinical review, minor).
  chargeIds: z.array(z.uuid()).min(1).optional(),
  reasonCode: z.enum(CREDIT_NOTE_REASON_CODES, {
    error: 'Elija el motivo de la nota de crédito',
  }),
  reasonText: z.string().max(1000).nullish(),
});
/** Body of POST /billing/sites/:siteId/invoices/:invoiceId/credit-notes. */
export class IssueCreditNoteDto extends createZodDto(issueCreditNoteSchema) {}

export const creditNoteQuerySchema = z.object({
  invoiceId: z.uuid().optional(),
  ...issuedDocumentQueryShape,
});
/** Query of GET /billing/sites/:siteId/credit-notes. */
export class CreditNoteQueryDto extends createZodDto(creditNoteQuerySchema) {}

const creditNoteLineSchema = z.object({
  chargeItemId: z.uuid(),
  serviceCode: z.string(),
  description: z.string(),
  quantity: z.string(),
  unitAmount: z.string(),
  discountAmount: z.string(),
  taxSriCode: z.string(),
  /** Base and tax of the line, as the credit note froze them. */
  netAmount: z.string(),
  taxAmount: z.string(),
});

const creditNoteResponseSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  /** The corrected invoice's sequential, for the list (BI-218). */
  invoiceSequential: z.string(),
  /** D-185.1, BI-235. The corrected invoice's printed number. */
  invoiceDocumentNumber: z.string(),
  siteId: z.uuid(),
  emissionPointId: z.uuid(),
  sequential: z.string(),
  /** D-185.1, BI-235. The printed number, `001-002-000000004`. */
  documentNumber: z.string(),
  accessKey: z.string().nullable(),
  reasonCode: z.enum(CREDIT_NOTE_REASON_CODES),
  /** What `<motivo>` says. */
  reason: z.string(),
  buyerIdentificationType: z.enum(BUYER_IDENTIFICATION_TYPES),
  buyerIdentification: z.string(),
  buyerName: z.string(),
  buyerEmail: z.string().nullable(),
  totals: totalsSchema,
  status: z.enum(['ISSUED', 'AUTHORISED', 'REJECTED']),
  issuedAt: z.iso.datetime(),
  lines: z.array(creditNoteLineSchema),
  electronic: electronicStateSchema.nullable(),
});
export type CreditNoteResponse = z.infer<typeof creditNoteResponseSchema>;

/** One credit note, and the list of GET /billing/sites/:siteId/credit-notes. */
export class CreditNoteDto extends createZodDto(creditNoteResponseSchema) {}
export class CreditNoteListDto extends createZodDto(
  z.object({
    items: z.array(creditNoteResponseSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
) {}

const issuedCreditNoteSchema = z.object({
  creditNote: creditNoteResponseSchema,
  /**
   * BI-214, BI-218. The account where the credited lines are waiting to be
   * billed again —the screen opens the issuance there—, or `null` when
   * nothing came back («Servicio no prestado»).
   */
  rebilledAccountId: z.uuid().nullable(),
});
export type IssuedCreditNoteResponse = z.infer<typeof issuedCreditNoteSchema>;
/** Response of issuing a credit note. */
export class IssuedCreditNoteDto extends createZodDto(issuedCreditNoteSchema) {}
