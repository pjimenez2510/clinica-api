import {
  addMonths,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  CreditNoteLineAlreadyCreditedError,
  CreditNoteLineNotInInvoiceError,
  CreditNoteReasonRequiredError,
} from './billing.errors';

/**
 * BI-208 to BI-214. Correcting an authorised invoice with a credit note, as
 * pure rules: the reason that goes in `<motivo>`, the window, which lines are
 * credited, and whether what was credited is billed again.
 *
 * The database says the same things on its own (`credit_note_*`, migration
 * `20261007033700_credit_note_and_corrections`); what this file adds is that
 * the cashier hears them as sentences before anything is numbered.
 */

/** BI-209 (D-128.2). The list; «Otro» asks for a text. */
export const CREDIT_NOTE_REASON_CODES = [
  'RECEIVER_DATA',
  'AMOUNT',
  'SERVICE_NOT_PROVIDED',
  'OTHER',
] as const;
export type CreditNoteReasonCode = (typeof CREDIT_NOTE_REASON_CODES)[number];

/**
 * What the SRI reads in `<motivo>` for each entry of the list. Spanish: it is
 * printed on a document the patient receives (D-152.5).
 */
export const CREDIT_NOTE_REASON_LABELS: Readonly<
  Record<Exclude<CreditNoteReasonCode, 'OTHER'>, string>
> = {
  RECEIVER_DATA: 'Error en los datos del receptor',
  AMOUNT: 'Error en el importe',
  SERVICE_NOT_PROVIDED: 'Servicio no prestado',
};

/** The XSD's `motivo`: 1 to 300 characters. */
export const MAX_CREDIT_NOTE_REASON = 300;

/**
 * BI-209. The text of `<motivo>`: the label of the list, or what was written
 * for «Otro», trimmed. A text sent with any other entry is ignored — the list
 * says it.
 */
export function resolveCreditNoteReason(
  code: CreditNoteReasonCode,
  otherText: string | null | undefined,
): string {
  if (code !== 'OTHER') return CREDIT_NOTE_REASON_LABELS[code];
  const text = (otherText ?? '').replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > MAX_CREDIT_NOTE_REASON) {
    throw new CreditNoteReasonRequiredError();
  }
  return text;
}

/**
 * BI-214 (D-152.3). Whether the credited lines go back to the account to be
 * billed again. A service that was not provided has nothing to bill.
 */
export function rebillsCreditedLines(code: CreditNoteReasonCode): boolean {
  return code !== 'SERVICE_NOT_PROVIDED';
}

/**
 * BI-094 (Res. NAC-DGERCGC25-00000014, art. 5; D-151.4). The last date, in
 * `America/Guayaquil`, on which an invoice issued on `issuedOn` admits a
 * credit note: «hasta dentro de doce (12) meses contados desde la fecha de
 * emisión».
 */
export function creditNoteDeadline(issuedOn: ClinicalDate): ClinicalDate {
  return addMonths(issuedOn, 12);
}

export function isWithinCreditNoteWindow(
  issuedOn: ClinicalDate,
  today: ClinicalDate,
): boolean {
  return today <= creditNoteDeadline(issuedOn);
}

/**
 * BI-208, BI-211. The charges a credit note credits: the ones asked for, or
 * every line of the invoice not yet credited when none is asked for. A line is
 * credited whole and once (D-152.6).
 */
export function selectCreditedCharges(
  invoiceChargeIds: readonly string[],
  alreadyCredited: ReadonlySet<string>,
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined || requested.length === 0) {
    const open = invoiceChargeIds.filter((id) => !alreadyCredited.has(id));
    if (open.length === 0) throw new CreditNoteLineAlreadyCreditedError();
    return open;
  }
  const lines = new Set(invoiceChargeIds);
  const unique = [...new Set(requested)];
  if (unique.some((id) => !lines.has(id))) {
    throw new CreditNoteLineNotInInvoiceError();
  }
  if (unique.some((id) => alreadyCredited.has(id))) {
    throw new CreditNoteLineAlreadyCreditedError();
  }
  // In the invoice's order, which is the order the XML prints.
  return invoiceChargeIds.filter((id) => unique.includes(id));
}
