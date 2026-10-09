import { describe, expect, it } from 'vitest';

import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import { invoiceBalance, summariseCashDay, type PaymentView } from './cash';
import { Money } from './money';

const now = new Date();

function aPayment(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: crypto.randomUUID(),
    invoiceId: 'invoice',
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

describe('billing/B6 — the balance and the cash day', () => {
  it('BI-103 derives the balance from the total, what was credited and what was paid', () => {
    expect(
      invoiceBalance({
        total: Money.parse('60.00'),
        creditedTotal: Money.parse('30.00'),
        paidTotal: Money.parse('20.00'),
      }).toString(),
    ).toBe('10.00');
  });

  it('BI-249 a paid invoice that is then credited is money owed back: negative', () => {
    expect(
      invoiceBalance({
        total: Money.parse('60.00'),
        creditedTotal: Money.parse('60.00'),
        paidTotal: Money.parse('60.00'),
      }).toString(),
    ).toBe('-60.00');
  });

  it('BI-105 adds the day by method, in the cashier order, and the cash expected is only the 01 methods', () => {
    const summary = summariseCashDay([
      aPayment({
        paymentMethodId: 'transfer',
        paymentMethodName: 'Transferencia',
        sriCode: '20',
        displayOrder: 4,
        amount: Money.parse('25.00'),
      }),
      aPayment({ amount: Money.parse('10.50') }),
      aPayment({ amount: Money.parse('4.50') }),
    ]);
    expect(
      summary.lines.map((line) => [
        line.methodName,
        line.paymentCount,
        line.amount.toString(),
      ]),
    ).toEqual([
      ['Efectivo', 2, '15.00'],
      ['Transferencia', 1, '25.00'],
    ]);
    expect(summary.collectedTotal.toString()).toBe('40.00');
    expect(summary.expectedCash.toString()).toBe('15.00');
  });

  it('BI-102 BI-251 a reversed payment counts nowhere', () => {
    const summary = summariseCashDay([
      aPayment(),
      aPayment({ reversal: { at: now, byId: 'rosa', reason: 'Error' } }),
    ]);
    expect(summary.collectedTotal.toString()).toBe('10.00');
    expect(summary.lines[0]!.paymentCount).toBe(1);
  });

  it('BI-252 an empty day closes at zero', () => {
    const summary = summariseCashDay([]);
    expect(summary.lines).toEqual([]);
    expect(summary.collectedTotal.toString()).toBe('0.00');
    expect(summary.expectedCash.toString()).toBe('0.00');
  });
});
