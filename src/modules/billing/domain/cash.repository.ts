import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type {
  CashDaySummary,
  CashSessionView,
  PaymentView,
  PendingInvoices,
} from './cash';
import type { PaymentMethod } from './invoice';
import type { Money } from './money';

/** One cashier's drawer: a user, at a site, on a day (BI-104). */
export interface CashDayKey {
  siteId: string;
  userId: string;
  day: ClinicalDate;
}

/**
 * The port for THE MONEY THAT CAME IN (B6). Implemented by
 * `PrismaCashRepository`; the balance, the closed day and the photo of the
 * close are the database's, and the adapter turns its refusals into the
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

  /** BI-102, BI-104. Once; never in a closed day. */
  reversePayment(reversal: {
    paymentId: string;
    reversedById: string;
    reason: string | null;
    now: Date;
  }): Promise<PaymentView>;

  /** BI-251. The day's payments of one drawer, reversed ones included. */
  listDayPayments(key: CashDayKey): Promise<PaymentView[]>;

  /** BI-251. What this cashier invoiced that day and is still owed. */
  pendingOfDay(key: CashDayKey): Promise<PendingInvoices>;

  findCashSession(key: CashDayKey): Promise<CashSessionView | null>;

  /**
   * BI-252, BI-253. Under the day's lock: reads the payments, lets the caller
   * summarise them, and writes the photo — so nothing comes in between.
   */
  closeCashSession(
    close: CashDayKey & {
      closedAt: Date;
      declaredCash: Money;
      note: string | null;
      summarise: (payments: readonly PaymentView[]) => CashDaySummary;
    },
  ): Promise<CashSessionView>;

  /** BI-249. The sum of the balances of a patient's invoices at a site. */
  patientBalance(query: { siteId: string; patientId: string }): Promise<Money>;
}

export const CASH_REPOSITORY = Symbol('CashRepository');
