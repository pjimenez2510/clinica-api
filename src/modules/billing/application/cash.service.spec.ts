import { describe, expect, it, vi } from 'vitest';

import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import type { BillingAccountRepository } from '../domain/billing.repository';
import {
  CashSessionClosedError,
  InvoiceNotFoundError,
  PaymentAlreadyReversedError,
  PaymentExceedsBalanceError,
  PaymentMethodInactiveError,
  PaymentMethodMismatchError,
  PaymentNotFoundError,
} from '../domain/billing.errors';
import type { PaymentView } from '../domain/cash';
import { Money } from '../domain/money';
import { CashService } from './cash.service';

const SITE = 'site-1';
const ROSA = { userId: 'rosa' };

function aPayment(overrides: Partial<PaymentView> = {}): PaymentView {
  const now = new Date();
  return {
    id: 'payment-1',
    invoiceId: 'invoice-1',
    invoiceDocumentNumber: '001-001-000000001',
    buyerName: 'Guamán Andrade, María José',
    paymentMethodId: 'cash',
    paymentMethodName: 'Efectivo',
    sriCode: '01',
    displayOrder: 1,
    amount: Money.parse('10.00'),
    reference: null,
    receivedAt: now,
    receivedById: 'rosa',
    cashDate: clinicalDateOf(now),
    cashSessionId: null,
    reversal: null,
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const mocks = {
    findInvoice: vi.fn().mockResolvedValue({
      id: 'invoice-1',
      totals: { total: Money.parse('60.00') },
      paidTotal: Money.parse('20.00'),
      creditedTotal: Money.ZERO,
      paymentMethod: '01',
    }),
    findPaymentMethod: vi
      .fn()
      .mockResolvedValue({ id: 'cash', sriCode: '01', active: true }),
    recordPayment: vi.fn().mockResolvedValue(aPayment()),
    findPayment: vi.fn().mockResolvedValue(aPayment()),
    reversePayment: vi.fn().mockResolvedValue(aPayment()),
    listOpenTurnPayments: vi.fn().mockResolvedValue([aPayment()]),
    findLastCashSession: vi.fn().mockResolvedValue(null),
    pendingOfTurn: vi
      .fn()
      .mockResolvedValue({ total: Money.parse('40.00'), count: 1 }),
    listCashSessionsOfDay: vi.fn().mockResolvedValue([]),
    closeCashSession: vi.fn().mockResolvedValue({}),
    patientBalance: vi.fn().mockResolvedValue(Money.ZERO),
    ...overrides,
  };
  return {
    service: new CashService(
      mocks,
      mocks as unknown as BillingAccountRepository,
    ),
    mocks,
  };
}

describe('billing/B6 — collecting', () => {
  it('BI-248 proposes the whole balance when no amount is given', async () => {
    const { service, mocks } = build();
    await service.collect(
      { siteId: SITE, invoiceId: 'invoice-1', paymentMethodId: 'cash' },
      ROSA,
    );
    expect(mocks.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ receivedById: 'rosa' }),
    );
    const sent = mocks.recordPayment.mock.calls[0]![0] as { amount: Money };
    expect(sent.amount.toString()).toBe('40.00');
  });

  it('BI-248 takes an instalment, with its reference trimmed', async () => {
    const { service, mocks } = build();
    await service.collect(
      {
        siteId: SITE,
        invoiceId: 'invoice-1',
        paymentMethodId: 'cash',
        amount: Money.parse('15.00'),
        reference: '  VCH-0042 ',
      },
      ROSA,
    );
    const sent = mocks.recordPayment.mock.calls[0]![0] as {
      amount: Money;
      reference: string;
    };
    expect(sent.amount.toString()).toBe('15.00');
    expect(sent.reference).toBe('VCH-0042');
  });

  it('BI-101 refuses more than the balance, and a fully paid invoice, before writing', async () => {
    const { service, mocks } = build();
    await expect(
      service.collect(
        {
          siteId: SITE,
          invoiceId: 'invoice-1',
          paymentMethodId: 'cash',
          amount: Money.parse('40.01'),
        },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentExceedsBalanceError);
    const paid = build({
      findInvoice: vi.fn().mockResolvedValue({
        id: 'invoice-1',
        totals: { total: Money.parse('60.00') },
        paidTotal: Money.parse('60.00'),
        creditedTotal: Money.ZERO,
        paymentMethod: '01',
      }),
    });
    await expect(
      paid.service.collect(
        { siteId: SITE, invoiceId: 'invoice-1', paymentMethodId: 'cash' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentExceedsBalanceError);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('BI-248 refuses an invoice of another site and an inactive method', async () => {
    const elsewhere = build({ findInvoice: vi.fn().mockResolvedValue(null) });
    await expect(
      elsewhere.service.collect(
        { siteId: SITE, invoiceId: 'x', paymentMethodId: 'cash' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
    const inactive = build({
      findPaymentMethod: vi
        .fn()
        .mockResolvedValue({ id: 'cash', sriCode: '01', active: false }),
    });
    await expect(
      inactive.service.collect(
        { siteId: SITE, invoiceId: 'invoice-1', paymentMethodId: 'cash' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentMethodInactiveError);
  });
});

describe('billing/B6 — the form the invoice declared', () => {
  it('BI-254 refuses a method of another SRI form than the invoice declared', async () => {
    const { service, mocks } = build({
      findPaymentMethod: vi
        .fn()
        .mockResolvedValue({ id: 'transfer', sriCode: '20', active: true }),
    });
    await expect(
      service.collect(
        { siteId: SITE, invoiceId: 'invoice-1', paymentMethodId: 'transfer' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentMethodMismatchError);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });
});

describe('billing/B6 — reversing and closing', () => {
  it('BI-251 reverses only one own payment: somebody else’s answers like none', async () => {
    const { service, mocks } = build({
      findPayment: vi
        .fn()
        .mockResolvedValue(aPayment({ receivedById: 'someone-else' })),
    });
    await expect(
      service.reverse(
        { siteId: SITE, paymentId: 'payment-1', reason: 'x' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
    expect(mocks.reversePayment).not.toHaveBeenCalled();

    const own = build();
    await own.service.reverse(
      { siteId: SITE, paymentId: 'payment-1', reason: ' Se cobró dos veces ' },
      ROSA,
    );
    expect(own.mocks.reversePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        reversedById: 'rosa',
        reason: 'Se cobró dos veces',
      }),
    );
  });

  it('BI-102 a reversed payment is not reversed again', async () => {
    const { service } = build({
      findPayment: vi.fn().mockResolvedValue(
        aPayment({
          reversal: { at: new Date(), byId: 'rosa', reason: 'Error' },
        }),
      ),
    });
    await expect(
      service.reverse(
        { siteId: SITE, paymentId: 'payment-1', reason: 'x' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(PaymentAlreadyReversedError);
  });

  it('BI-104 a payment already in a close is not reversed: it says so before writing', async () => {
    const { service, mocks } = build({
      findPayment: vi
        .fn()
        .mockResolvedValue(aPayment({ cashSessionId: 'session-1' })),
    });
    await expect(
      service.reverse(
        { siteId: SITE, paymentId: 'payment-1', reason: 'x' },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(CashSessionClosedError);
    expect(mocks.reversePayment).not.toHaveBeenCalled();
  });

  it('BI-251 the open turn is what no close took, since the last close, with what is still owed since then', async () => {
    const lastClose = new Date(Date.now() - 60 * 60 * 1000);
    const { service, mocks } = build({
      findLastCashSession: vi
        .fn()
        .mockResolvedValue({ id: 'session-1', closedAt: lastClose }),
    });
    const turn = await service.openTurn({ siteId: SITE }, ROSA);
    expect(mocks.listOpenTurnPayments).toHaveBeenCalledWith({
      siteId: SITE,
      userId: 'rosa',
    });
    expect(mocks.pendingOfTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        userId: 'rosa',
        since: lastClose,
      }),
    );
    expect(turn.previousSession).toEqual({
      id: 'session-1',
      closedAt: lastClose,
    });
    expect(turn.summary.collectedTotal.toString()).toBe('10.00');
    expect(turn.pending.total.toString()).toBe('40.00');
  });

  it('BI-251 before the first close the turn has no beginning, and what is owed counts from the start', async () => {
    const { service, mocks } = build();
    const turn = await service.openTurn({ siteId: SITE }, ROSA);
    expect(turn.previousSession).toBeNull();
    expect(mocks.pendingOfTurn).toHaveBeenCalledWith(
      expect.objectContaining({ since: null }),
    );
  });

  it('BI-258 the closes of a day are today in Guayaquil by default, of one’s own drawer', async () => {
    const { service, mocks } = build();
    await service.closesOfDay({ siteId: SITE }, ROSA);
    expect(mocks.listCashSessionsOfDay).toHaveBeenCalledWith({
      siteId: SITE,
      userId: 'rosa',
      day: clinicalDateOf(new Date()),
    });
  });

  it('BI-252 closes the open turn with the cash counted and the last close seen, at the application’s instant', async () => {
    const { service, mocks } = build();
    const before = Date.now();
    await service.close(
      {
        siteId: SITE,
        declaredCash: Money.parse('9.00'),
        previousSessionId: 'session-1',
        note: ' ',
      },
      ROSA,
    );
    const call = mocks.closeCashSession.mock.calls[0]![0] as {
      closedAt: Date;
    };
    expect(mocks.closeCashSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'rosa',
        seenPreviousSessionId: 'session-1',
        note: null,
      }),
    );
    expect(call.closedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
