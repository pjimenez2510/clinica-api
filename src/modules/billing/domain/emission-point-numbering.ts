/**
 * BI-306 to BI-309 (D-262). The «próximo número» of an emission point.
 *
 * The SRI numbers invoices (`01`) and credit notes (`04`) apart, per RUC,
 * establishment and point; so does this. What is FIXED here is a floor, never
 * a counter: the number that goes out is the larger of «the largest used plus
 * one» and the floor, computed by the database under the point's lock
 * (`next_voucher_sequential`). This file only says what the screen is told.
 */
export const VOUCHER_TYPES = ['01', '04'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/** The SRI prints nine positions: the last number a point can issue. */
export const MAX_SEQUENTIAL = 999_999_999;

export interface NumberingChange {
  at: Date;
  byId: string;
  byName: string;
  reason: string;
}

/** One point and type, as stored. */
export interface NumberingRecord {
  emissionPointId: string;
  emissionPointCode: string;
  emissionPointActive: boolean;
  documentType: VoucherType;
  /** The largest sequential used on this point for this type; 0 for none. */
  usedUpTo: number;
  nextSequential: number | null;
  previousSystemLast: number | null;
  lastChange: NumberingChange | null;
}

export interface NumberingView extends NumberingRecord {
  /** The number the next voucher of this type will carry. */
  nextToIssue: number;
  /** BI-309. It does not reach past what the previous system issued. */
  belowPreviousSystem: boolean;
}

/** BI-308, BI-309. The same rule `next_voucher_sequential` applies. */
export function numberingView(record: NumberingRecord): NumberingView {
  const nextToIssue = Math.max(record.usedUpTo + 1, record.nextSequential ?? 0);
  return {
    ...record,
    nextToIssue,
    belowPreviousSystem:
      record.previousSystemLast !== null &&
      nextToIssue <= record.previousSystemLast,
  };
}
