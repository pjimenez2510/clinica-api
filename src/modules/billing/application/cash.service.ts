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
  CashSessionClosedError,
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
  summariseCashTurn,
  type CashSessionView,
  type CashTurnSummary,
  type PaymentView,
  type PendingInvoices,
} from '../domain/cash';
import {
  CASH_REPOSITORY,
  type CashRepository,
} from '../domain/cash.repository';
import { Money } from '../domain/money';
import type { Requester } from './service-catalogue.service';

/** BI-251. One cashier's open turn, as «Caja» shows it. */
export interface CashTurn {
  /** The drawer's last close: where this turn began. `null` before the first. */
  previousSession: { id: string; closedAt: Date } | null;
  payments: PaymentView[];
  summary: CashTurnSummary;
  pending: PendingInvoices;
}

/**
 * THE MONEY THAT CAME IN (billing B6): collecting an invoice, undoing a
 * payment, and closing a turn (D-197.4).
 *
 * A service of its own and not more methods of `InvoicingService`: issuing a
 * document and receiving money change for different reasons — the SRI's
 * rules against the clinic's cash handling — and the close shares nothing
 * with the voucher. The one place they meet, collecting at the moment of
 * issuing (BI-247), is the issuance's transaction, in its own repository.
 *
 * Every sum that a race could break — the balance, the closed day, the
 * photo — is the database's; what is here is what the screen needs before
 * asking: the default amount, whose payment it is, which turn is open.
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
    // BI-104. Closed, it is in a photo; undoing it is a refund (D-197.3).
    if (payment.cashSessionId) throw new CashSessionClosedError();
    return this.cash.reversePayment({
      paymentId: payment.id,
      reversedById: requester.userId,
      reason: command.reason?.trim() || null,
      now: new Date(),
    });
  }

  /** BI-251. The payments in no close yet, and since when. */
  async openTurn(
    query: { siteId: string },
    requester: Requester,
  ): Promise<CashTurn> {
    const key = { siteId: query.siteId, userId: requester.userId };
    const [payments, previous] = await Promise.all([
      this.cash.listOpenTurnPayments(key),
      this.cash.findLastCashSession(key),
    ]);
    const pending = await this.cash.pendingOfTurn({
      ...key,
      since: previous?.closedAt ?? null,
      until: new Date(),
    });
    return {
      previousSession: previous
        ? { id: previous.id, closedAt: previous.closedAt }
        : null,
      payments,
      summary: summariseCashTurn(payments),
      pending,
    };
  }

  /** BI-258. The closes of one Guayaquil day; today when none is asked for. */
  closesOfDay(
    query: { siteId: string; day?: ClinicalDate },
    requester: Requester,
  ): Promise<CashSessionView[]> {
    return this.cash.listCashSessionsOfDay({
      siteId: query.siteId,
      userId: requester.userId,
      day: query.day ?? clinicalDateOf(new Date()),
    });
  }

  /** BI-104, BI-105, BI-252, BI-253, BI-255. */
  close(
    command: {
      siteId: string;
      declaredCash: Money;
      /** BI-252. The last close the screen showed; `null` if none. */
      previousSessionId: string | null;
      /** BI-255. */
      seenExpectedCash?: Money;
      note?: string | null;
    },
    requester: Requester,
  ): Promise<CashSessionView> {
    return this.cash.closeCashSession({
      siteId: command.siteId,
      userId: requester.userId,
      // The application's clock, as every instant the screen compares; read
      // by the repository once it holds the drawer's lock.
      clock: () => new Date(),
      declaredCash: command.declaredCash,
      seenPreviousSessionId: command.previousSessionId,
      seenExpectedCash: command.seenExpectedCash,
      note: command.note?.trim() || null,
      summarise: summariseCashTurn,
    });
  }

  /** BI-249. What the patient owes at this site, all invoices together. */
  patientBalance(query: { siteId: string; patientId: string }): Promise<Money> {
    return this.cash.patientBalance(query);
  }
}
