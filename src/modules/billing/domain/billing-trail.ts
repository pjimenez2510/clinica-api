/**
 * BI-132, BI-273. Who issued a document and from where, handed to the
 * repository that writes it so its `access_audit` entry goes into the SAME
 * transaction: the entry exists if and only if the document committed.
 *
 * Not the shared `AccessAuditRecorder`, on purpose: that port logs and never
 * throws, which is right for a read and wrong for an issuance — a recorder
 * that swallowed its failure after the commit left an invoice nobody could
 * be held to, and one written before it could claim an invoice the
 * transaction undid. Identifiers only, never a snapshot (BI-007).
 */
export interface BillingTrail {
  /** The internal user id, never their cedula. */
  userId: string;
  ip?: string;
  userAgent?: string;
}
