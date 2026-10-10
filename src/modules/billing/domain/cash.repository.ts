import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  CashSessionView,
  CashTurnSummary,
  PaymentView,
  PendingInvoices,
} from './cash';
import type { PaymentMethod } from './invoice';
import type { Money } from './money';

/** One cashier's drawer: a user, at a site (BI-104). */
export interface CashDrawerKey {
  siteId: string;
  userId: string;
}

/**
 * The port for THE MONEY THAT CAME IN (B6). Implemented by
 * `PrismaCashRepository`; the balance, the closed payment and the photo of
 * the close are the database's, and the adapter turns its refusals into the
 * errors of `billing.errors.ts`.
 */
export interface CashRepository {
  findPaymentMethod(id: string): Promise<{
    id: string;
    sriCode: PaymentMethod;
    active: boolean;
  } | null>;

  /** BI-101, BI-248, BI-250. The database writes the cash date. */
  recordPayment(payment: {
    invoiceId: string;
    siteId: string;
    paymentMethodId: string;
    amount: Money;
    reference: string | null;
    receivedAt: Date;
    receivedById: string;
  }): Promise<PaymentView>;

  /** BI-251, BI-135. One payment of this site, or `null`. */
  findPayment(query: {
    paymentId: string;
    siteId: string;
  }): Promise<PaymentView | null>;

  /** BI-102, BI-104, BI-253. Once, under the drawer's lock; never closed. */
  reversePayment(reversal: {
    paymentId: string;
    reversedById: string;
    reason: string | null;
    now: Date;
  }): Promise<PaymentView>;

  /** BI-251. The payments of the open turn, reversed ones included. */
  listOpenTurnPayments(key: CashDrawerKey): Promise<PaymentView[]>;

  /** BI-251. The drawer's last close, or `null` before the first. */
  findLastCashSession(key: CashDrawerKey): Promise<CashSessionView | null>;

  /**
   * BI-251. What this cashier invoiced after `since` (her last close; all of
   * it before the first) up to `until`, and is still owed.
   */
  pendingOfTurn(
    key: CashDrawerKey & { since: Date | null; until: Date },
  ): Promise<PendingInvoices>;

  /** BI-258. The drawer's closes whose instant falls on that Guayaquil day. */
  listCashSessionsOfDay(
    key: CashDrawerKey & { day: ClinicalDate },
  ): Promise<CashSessionView[]>;

  /**
   * BI-252, BI-253, BI-255. Under the drawer's lock: reads the open turn,
   * lets the caller summarise it, writes the photo and marks its payments —
   * so nothing comes in between.
   */
  closeCashSession(
    close: CashDrawerKey & {
      closedAt: Date;
      declaredCash: Money;
      /** BI-252. The last close the cashier saw; `null` if she saw none. */
      seenPreviousSessionId: string | null;
      /** BI-255. The expected cash the cashier was shown, when she was. */
      seenExpectedCash?: Money;
      note: string | null;
      summarise: (payments: readonly PaymentView[]) => CashTurnSummary;
    },
  ): Promise<CashSessionView>;

  /** BI-249. The sum of the balances of a patient's invoices at a site. */
  patientBalance(query: { siteId: string; patientId: string }): Promise<Money>;
}

export const CASH_REPOSITORY = Symbol('CashRepository');
