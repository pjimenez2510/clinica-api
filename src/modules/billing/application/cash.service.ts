import { Inject, Injectable } from '@nestjs/common';

import {
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  BILLING_ACCOUNT_REPOSITORY,
  type BillingAccountRepository,
} from '../domain/billing.repository';
import {
  CashSessionDateInFutureError,
  InvoiceNotFoundError,
  PaymentAlreadyReversedError,
  PaymentExceedsBalanceError,
  PaymentMethodInactiveError,
  PaymentMethodMismatchError,
  PaymentMethodNotFoundError,
  PaymentNotFoundError,
} from '../domain/billing.errors';
import {
  invoiceBalance,
  summariseCashDay,
  type CashDaySummary,
  type CashSessionView,
  type PaymentView,
  type PendingInvoices,
} from '../domain/cash';
import {
  CASH_REPOSITORY,
  type CashRepository,
} from '../domain/cash.repository';
import { Money } from '../domain/money';
import type { Requester } from './service-catalogue.service';

/** BI-251. One cashier's day, as «Caja del día» shows it. */
export interface CashDay {
  day: ClinicalDate;
  payments: PaymentView[];
  summary: CashDaySummary;
  pending: PendingInvoices;
  /** `null` while the day is open. */
  session: CashSessionView | null;
}

/**
 * THE MONEY THAT CAME IN (billing B6): collecting an invoice, undoing a
 * payment, and closing the day.
 *
 * A service of its own and not more methods of `InvoicingService`: issuing a
 * document and receiving money change for different reasons — the SRI's
 * rules against the clinic's cash handling — and the close shares nothing
 * with the voucher. The one place they meet, collecting at the moment of
 * issuing (BI-247), is the issuance's transaction, in its own repository.
 *
 * Every sum that a race could break — the balance, the closed day, the
 * photo — is the database's; what is here is what the screen needs before
 * asking: the default amount, whose payment it is, which day is today.
 */
@Injectable()
export class CashService {
  constructor(
    @Inject(CASH_REPOSITORY) private readonly cash: CashRepository,
    @Inject(BILLING_ACCOUNT_REPOSITORY)
    private readonly accounts: BillingAccountRepository,
  ) {}

  /** BI-248. The balance by default; a smaller amount is an instalment. */
  async collect(
    command: {
      siteId: string;
      invoiceId: string;
      paymentMethodId: string;
      amount?: Money;
      reference?: string | null;
    },
    requester: Requester,
  ): Promise<PaymentView> {
    const invoice = await this.accounts.findInvoice({
      invoiceId: command.invoiceId,
      siteId: command.siteId,
    });
    if (!invoice) throw new InvoiceNotFoundError();

    const method = await this.cash.findPaymentMethod(command.paymentMethodId);
    if (!method) throw new PaymentMethodNotFoundError();
    if (!method.active) throw new PaymentMethodInactiveError();
    // BI-254. The voucher already told the SRI how it is paid: the money
    // comes in with a method of that form, or the declaration lies.
    if (
      invoice.paymentMethod !== null &&
      method.sriCode !== invoice.paymentMethod
    ) {
      throw new PaymentMethodMismatchError();
    }

    const balance = invoiceBalance({
      total: invoice.totals.total,
      creditedTotal: invoice.creditedTotal,
      paidTotal: invoice.paidTotal,
    });
    const amount = command.amount ?? balance;
    // Nothing owed, or more than what is: the database would say the same
    // under its lock; saying it here spares a write that cannot succeed.
    if (!amount.isGreaterThan(Money.ZERO) || amount.isGreaterThan(balance)) {
      throw new PaymentExceedsBalanceError();
    }

    return this.cash.recordPayment({
      invoiceId: invoice.id,
      siteId: command.siteId,
      paymentMethodId: method.id,
      amount,
      reference: command.reference?.trim() || null,
      // The application's clock (BI-250); the database derives the day.
      receivedAt: new Date(),
      receivedById: requester.userId,
    });
  }

  /** BI-102, BI-251. Only one's own payment, once, with its reason. */
  async reverse(
    command: { siteId: string; paymentId: string; reason?: string | null },
    requester: Requester,
  ): Promise<PaymentView> {
    const payment = await this.cash.findPayment({
      paymentId: command.paymentId,
      siteId: command.siteId,
    });
    // D-197.5. Someone else's payment answers like one that does not exist.
    if (!payment || payment.receivedById !== requester.userId) {
      throw new PaymentNotFoundError();
    }
    if (payment.reversal) throw new PaymentAlreadyReversedError();
    return this.cash.reversePayment({
      paymentId: payment.id,
      reversedById: requester.userId,
      reason: command.reason?.trim() || null,
      now: new Date(),
    });
  }

  /** BI-251. Today in Guayaquil when no day is asked for. */
  async day(
    query: { siteId: string; day?: ClinicalDate },
    requester: Requester,
  ): Promise<CashDay> {
    const key = {
      siteId: query.siteId,
      userId: requester.userId,
      day: query.day ?? clinicalDateOf(new Date()),
    };
    const [payments, pending, session] = await Promise.all([
      this.cash.listDayPayments(key),
      this.cash.pendingOfDay(key),
      this.cash.findCashSession(key),
    ]);
    return {
      day: key.day,
      payments,
      summary: summariseCashDay(payments),
      pending: session
        ? { total: session.pendingTotal, count: session.pendingCount }
        : pending,
      session,
    };
  }

  /** BI-104, BI-105, BI-252, BI-253. */
  async close(
    command: {
      siteId: string;
      day: ClinicalDate;
      declaredCash: Money;
      /** BI-255. */
      seenExpectedCash?: Money;
      note?: string | null;
    },
    requester: Requester,
  ): Promise<CashSessionView> {
    const now = new Date();
    if (command.day > clinicalDateOf(now)) {
      throw new CashSessionDateInFutureError();
    }
    return this.cash.closeCashSession({
      siteId: command.siteId,
      userId: requester.userId,
      day: command.day,
      closedAt: now,
      declaredCash: command.declaredCash,
      seenExpectedCash: command.seenExpectedCash,
      note: command.note?.trim() || null,
      summarise: summariseCashDay,
    });
  }

  /** BI-249. What the patient owes at this site, all invoices together. */
  patientBalance(query: { siteId: string; patientId: string }): Promise<Money> {
    return this.cash.patientBalance(query);
  }
}
