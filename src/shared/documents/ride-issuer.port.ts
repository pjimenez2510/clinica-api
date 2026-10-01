/**
 * SRI-072. The RIDE, issued and filed by `documents` (DOC-076), for `sri` to
 * attach to the e-mail that delivers an authorised voucher.
 *
 * A SHARED PORT because no module imports another: `documents` owns the
 * layout of the RIDE and its archive; `sri` only knows when one is due. The
 * RIDE is filed in the name of whoever issued the invoice — an automatic
 * delivery has no other person behind it, and `document_render.issued_by_id`
 * is not optional.
 */
export interface IssuedRide {
  content: Buffer;
  fileName: string;
}

export interface RideIssuer {
  issueRide(invoiceId: string, issuedById: string): Promise<IssuedRide>;
}
export const RIDE_ISSUER = Symbol('RideIssuer');
