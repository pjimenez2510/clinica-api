import { describe, expect, it, vi } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import type { BillingAccountRepository } from '../domain/billing.repository';
import {
  CashSessionDateInFutureError,
  InvoiceNotFoundError,
  PaymentAlreadyReversedError,
  PaymentExceedsBalanceError,
  PaymentMethodInactiveError,
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
    }),
    findPaymentMethod: vi
      .fn()
      .mockResolvedValue({ id: 'cash', sriCode: '01', active: true }),
    recordPayment: vi.fn().mockResolvedValue(aPayment()),
    findPayment: vi.fn().mockResolvedValue(aPayment()),
    reversePayment: vi.fn().mockResolvedValue(aPayment()),
    listDayPayments: vi.fn().mockResolvedValue([aPayment()]),
    pendingOfDay: vi
      .fn()
      .mockResolvedValue({ total: Money.parse('40.00'), count: 1 }),
    findCashSession: vi.fn().mockResolvedValue(null),
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

  it('BI-251 the day is today in Guayaquil by default, summarised, with what is still owed', async () => {
    const { service, mocks } = build();
    const day = await service.day({ siteId: SITE }, ROSA);
    expect(day.day).toBe(clinicalDateOf(new Date()));
    expect(mocks.listDayPayments).toHaveBeenCalledWith({
      siteId: SITE,
      userId: 'rosa',
      day: clinicalDateOf(new Date()),
    });
    expect(day.summary.collectedTotal.toString()).toBe('10.00');
    expect(day.pending.total.toString()).toBe('40.00');
    expect(day.session).toBeNull();
  });

  it('BI-252 a closed day shows what was pending when it closed, not now', async () => {
    const { service } = build({
      findCashSession: vi.fn().mockResolvedValue({
        pendingTotal: Money.parse('5.00'),
        pendingCount: 1,
      }),
    });
    const day = await service.day({ siteId: SITE }, ROSA);
    expect(day.pending.total.toString()).toBe('5.00');
  });

  it('BI-252 refuses to close a day still to come, and closes today with the cash counted', async () => {
    const { service, mocks } = build();
    const today = clinicalDateOf(new Date());
    await expect(
      service.close(
        { siteId: SITE, day: addDays(today, 1), declaredCash: Money.ZERO },
        ROSA,
      ),
    ).rejects.toBeInstanceOf(CashSessionDateInFutureError);
    await service.close(
      {
        siteId: SITE,
        day: today,
        declaredCash: Money.parse('9.00'),
        note: ' ',
      },
      ROSA,
    );
    expect(mocks.closeCashSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'rosa', day: today, note: null }),
    );
  });
});
