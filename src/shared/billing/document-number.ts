/**
 * SRI-019, SRI-070. The invoice's printed number, `001-002-000000123`.
 *
 * Once the invoice has an access key, its series and sequential come FROM THE
 * KEY (digits 25–39), which never changes: the RIDE handed to the patient and
 * the voucher the SRI authorised keep saying the same number after somebody
 * corrects the site's establishment code. Before the key exists it is the
 * site's code as it is now — and `???` when the site has none, never an
 * invented `001` (SRI-008).
 *
 * Shared because `documents` prints it and `sri` lists it, and neither may
 * import the other.
 */
export function invoiceDocumentNumber(invoice: {
  accessKey: string | null;
  establishmentCode: string | null;
  emissionPointCode: string;
  sequential: string;
}): string {
  if (invoice.accessKey !== null && /^[0-9]{49}$/.test(invoice.accessKey)) {
    const key = invoice.accessKey;
    return `${key.slice(24, 27)}-${key.slice(27, 30)}-${key.slice(30, 39)}`;
  }
  return `${invoice.establishmentCode ?? '???'}-${invoice.emissionPointCode}-${invoice.sequential}`;
}
