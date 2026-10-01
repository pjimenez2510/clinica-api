/**
 * SRI-041, SRI-060. How `billing` and `sri` talk without importing each other.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SHARED PORT AND WHY IT CANNOT FAIL TOWARDS BILLING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No module imports another (`sin-imports-entre-modulos`). `billing` decides
 * what is invoiced; `sri` turns the issued invoice into an electronic voucher
 * (ADR-004: the key is computed by whoever does NOT decide what is invoiced).
 * So `billing` announces the issuance through this port, AFTER its own
 * transaction has committed, and `sri` implements it.
 *
 * ⚠️ `prepare` NEVER THROWS (REQ-086, SRI-041). No certificate, no SRI
 * establishment code, a database hiccup in the voucher table: none of it may
 * turn a valid, numbered, committed invoice into an error on the cashier's
 * screen. The implementation logs and swallows, and the periodic sweep
 * (SRI-056) prepares whatever this call did not.
 */
export interface ElectronicVoucherPreparer {
  prepare(invoiceId: string): Promise<void>;
}
export const ELECTRONIC_VOUCHER_PREPARER = Symbol('ElectronicVoucherPreparer');

/**
 * SRI-060. The electronic state of each invoice, as `billing` shows it.
 * Written as unions and not imported from `sri`: a shared port is read by
 * code that may not know that module exists.
 */
export type ElectronicVoucherState =
  | 'PREPARED'
  | 'SIGNED'
  | 'RECEIVED'
  | 'AUTHORISED'
  | 'RETURNED'
  | 'NOT_AUTHORISED';

export interface ElectronicVoucherSummary {
  voucherId: string;
  state: ElectronicVoucherState;
  /** Why a PREPARED voucher is not moving, when it is not. */
  blockedReason: string | null;
  accessKey: string;
  authorisedAt: Date | null;
  /** `PENDING`, `SENT`, `NO_EMAIL` or `FAILED`, once authorised. */
  deliveryStatus: string | null;
  /** The SRI's last message, for the screen. */
  lastMessage: { identifier: string; message: string } | null;
}

export interface ElectronicVoucherStatusReader {
  /** Invoices with no voucher are simply absent from the map. */
  summariesOf(
    invoiceIds: readonly string[],
  ): Promise<Map<string, ElectronicVoucherSummary>>;
}
export const ELECTRONIC_VOUCHER_STATUS = Symbol(
  'ElectronicVoucherStatusReader',
);
