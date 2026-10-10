import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { PaymentMethod } from './invoice';
import { Money } from './money';

/**
 * THE MONEY THAT CAME IN (billing B6, BI-101 to BI-105, BI-247 to BI-258).
 *
 * Pure: what a balance is, and what a turn of one cashier adds up to. A turn
 * is the payments of one drawer — a user at a site — that are in no close
 * yet (D-197.4): closing takes them, and the next payment opens the next
 * turn. Whether a payment fits the balance and whether it is already closed
 * is decided by the DATABASE under its locks (`trg_payment_guard`,
 * `trg_payment_only_reverses`); these functions only say what the screen
 * shows and what the close writes, and the database checks the close against
 * its payments (`trg_cash_session_matches_its_payments`).
 */

/**
 * BI-105, D-197.1. The SRI form of payment of cash, «sin utilización del
 * sistema financiero»: what can be counted in the drawer.
 */
export const CASH_SRI_CODE: PaymentMethod = '01';

/** BI-103. What an invoice still owes; negative is money owed BACK (D-197.3). */
export function invoiceBalance(invoice: {
  total: Money;
  creditedTotal: Money;
  paidTotal: Money;
}): Money {
  return invoice.total.minus(invoice.creditedTotal).minus(invoice.paidTotal);
}

/** One payment, as the cash day reads it. */
export interface PaymentView {
  id: string;
  invoiceId: string;
  /** The printed number of its invoice (SRI-019) and to whom it was made out. */
  invoiceDocumentNumber: string;
  buyerName: string;
  paymentMethodId: string;
  paymentMethodName: string;
  sriCode: PaymentMethod;
  displayOrder: number;
  amount: Money;
  reference: string | null;
  receivedAt: Date;
  receivedById: string;
  /** BI-250. Written by the database. */
  cashDate: ClinicalDate;
  /** BI-104, BI-252. The close that took it; `null` while its turn is open. */
  cashSessionId: string | null;
  /** BI-102. The reason is optional (D-126). */
  reversal: { at: Date; byId: string; reason: string | null } | null;
}

/** What one method brought in during a turn. */
export interface CashLine {
  paymentMethodId: string;
  methodName: string;
  sriCode: PaymentMethod;
  paymentCount: number;
  amount: Money;
}

export interface CashTurnSummary {
  lines: CashLine[];
  collectedTotal: Money;
  /** BI-105. What should be in the drawer. */
  expectedCash: Money;
}

/**
 * BI-105, BI-251. The turn by method, in the order the cashier sees the
 * methods; a reversed payment counts nowhere.
 */
export function summariseCashTurn(
  payments: readonly PaymentView[],
): CashTurnSummary {
  const byMethod = new Map<string, CashLine>();
  const order = new Map<string, number>();
  for (const payment of payments) {
    if (payment.reversal) continue;
    const line = byMethod.get(payment.paymentMethodId) ?? {
      paymentMethodId: payment.paymentMethodId,
      methodName: payment.paymentMethodName,
      sriCode: payment.sriCode,
      paymentCount: 0,
      amount: Money.ZERO,
    };
    line.paymentCount += 1;
    line.amount = line.amount.plus(payment.amount);
    byMethod.set(payment.paymentMethodId, line);
    order.set(payment.paymentMethodId, payment.displayOrder);
  }
  const lines = [...byMethod.values()].sort(
    (a, b) =>
      (order.get(a.paymentMethodId) ?? 0) -
        (order.get(b.paymentMethodId) ?? 0) ||
      a.methodName.localeCompare(b.methodName, 'es'),
  );
  return {
    lines,
    collectedTotal: Money.sum(lines.map((line) => line.amount)),
    expectedCash: Money.sum(
      lines
        .filter((line) => line.sriCode === CASH_SRI_CODE)
        .map((line) => line.amount),
    ),
  };
}

/** BI-252, BI-258. The photo of a close, as it was written. */
export interface CashSessionView {
  id: string;
  siteId: string;
  userId: string;
  userName: string;
  /** BI-258. The close before it in the same drawer: where the turn began. */
  previousClosedAt: Date | null;
  closedAt: Date;
  lines: CashLine[];
  collectedTotal: Money;
  expectedCash: Money;
  declaredCash: Money;
  /** Declared minus expected: + is over, − is short. */
  difference: Money;
  pendingTotal: Money;
  pendingCount: number;
  note: string | null;
}

/** BI-251. What the cashier invoiced during the turn and is still owed. */
export interface PendingInvoices {
  total: Money;
  count: number;
}
