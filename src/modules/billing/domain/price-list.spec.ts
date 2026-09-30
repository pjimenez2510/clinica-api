import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { PriceNegativeAmountError, PricePeriodInvalidError } from './billing.errors'; // prettier-ignore
import { Money } from './money';
import {
  type PriceRow,
  checkNewPrice,
  isInForceOn,
  planPriceChange,
  priceInForceOn,
  toClinicalDate,
} from './price-list';

/**
 * Price validity as `[from, to)`, resolving the price of a date, and changing
 * a price by closing one period and opening the next. Pure domain unit; cites
 * BI-002, BI-041, BI-043, BI-044 and BI-047.
 */

const on = (date: string) => parseClinicalDate(date);

const price = (
  id: string,
  amount: string,
  validFrom: string,
  validTo: string | null = null,
): PriceRow => ({
  id,
  billableServiceId: 'service',
  amount: Money.parse(amount),
  validFrom: on(validFrom),
  validTo: validTo === null ? null : on(validTo),
});

describe('la vigencia de un precio', () => {
  it('BI-041 trata la vigencia como `[desde, hasta)` con el fin exclusivo', () => {
    const period = { validFrom: on('2026-01-01'), validTo: on('2026-07-01') };

    expect(isInForceOn(period, on('2025-12-31'))).toBe(false);
    expect(isInForceOn(period, on('2026-01-01'))).toBe(true);
    expect(isInForceOn(period, on('2026-06-30'))).toBe(true);
    // THE DAY THE PRICE ENDS BELONGS TO THE NEXT ONE, and only to it. With a
    // closed interval it would belong to both and resolving that date would
    // return two rows — the ambiguity `price_temporal_unique` exists to stop.
    expect(isInForceOn(period, on('2026-07-01'))).toBe(false);
  });

  it('BI-041 trata la vigencia abierta como vigente para siempre', () => {
    const period = { validFrom: on('2026-01-01'), validTo: null };
    expect(isInForceOn(period, on('2099-12-31'))).toBe(true);
  });

  it('BI-047 resuelve el precio de una fecha y devuelve nulo si no hay ninguno', () => {
    const prices = [
      price('new', '35.00', '2026-07-01'),
      price('old', '30.00', '2026-01-01', '2026-07-01'),
    ];

    expect(priceInForceOn(prices, on('2026-06-15'))?.id).toBe('old');
    expect(priceInForceOn(prices, on('2026-07-01'))?.id).toBe('new');
    expect(priceInForceOn(prices, on('2025-12-31'))).toBeNull();
  });

  it('BI-043 admite el importe cero y rechaza el negativo', () => {
    // Zero is a real price: the included follow-up visit, the service an
    // agreement covers in full. Telling it apart from «no price» is what makes
    // BI-047 mean anything.
    expect(() =>
      checkNewPrice(Money.parse('0.00'), {
        validFrom: on('2026-01-01'),
        validTo: null,
      }),
    ).not.toThrow();

    expect(() =>
      checkNewPrice(Money.parse('0.00').minus(Money.parse('0.01')), {
        validFrom: on('2026-01-01'),
        validTo: null,
      }),
    ).toThrow(PriceNegativeAmountError);
  });

  it('BI-041 rechaza una vigencia vacía antes de que la base dé un mensaje peor', () => {
    expect(() =>
      checkNewPrice(Money.parse('10.00'), {
        validFrom: on('2026-07-01'),
        validTo: on('2026-07-01'),
      }),
    ).toThrow(PricePeriodInvalidError);
  });
});

describe('BI-044 cambiar un precio es cerrar una vigencia y abrir otra', () => {
  it('BI-044 cierra la fila anterior EL MISMO DÍA en que empieza la nueva', () => {
    const change = planPriceChange(
      price('old', '30.00', '2026-01-01'),
      Money.parse('35.00'),
      on('2026-07-01'),
    );

    // The same date on both sides, because the period is half-open: the old
    // row covers up to but not including 1 July and the new one starts there.
    // A day earlier would leave a hole with no price; a day later would
    // overlap, and `price_temporal_unique` refuses that.
    expect(change.closes).toEqual({
      priceId: 'old',
      validTo: on('2026-07-01'),
    });
    expect(change.opens.amount.toString()).toBe('35.00');
    expect(change.opens.validFrom).toBe(on('2026-07-01'));
    expect(change.opens.validTo).toBeNull();
  });

  it('BI-044 no cierra nada cuando la prestación no tenía precio', () => {
    const change = planPriceChange(
      null,
      Money.parse('30.00'),
      on('2026-01-01'),
    );
    expect(change.closes).toBeNull();
  });

  it('BI-044 rechaza fijar un precio en una fecha anterior al inicio del vigente', () => {
    // Closing a row on or before its own start produces an empty period, which
    // `price_period_not_empty` refuses with a message nobody can act on.
    expect(() =>
      planPriceChange(
        price('old', '30.00', '2026-07-01'),
        Money.parse('35.00'),
        on('2026-01-01'),
      ),
    ).toThrow(PricePeriodInvalidError);
  });

  it('BI-002 lee una columna `date` como el día del calendario que guarda', () => {
    // A `@db.Date` arrives as midnight UTC. Reading it with local getters would
    // move it a day west of Greenwich — and here that does not shift a metric,
    // it changes WHICH PRICE APPLIES.
    expect(toClinicalDate(new Date('2026-07-01T00:00:00Z'))).toBe(
      on('2026-07-01'),
    );
  });
});
