import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { InvalidChargeQuantityError } from './billing.errors';
import {
  type ChargeLine,
  type ChargeResolution,
  freezeCharge,
  lineBase,
  lineGross,
  lineTax,
  totalsOf,
} from './charge';
import { Money, Percentage, Quantity } from './money';

/**
 * The charge as a frozen copy of the price, and the arithmetic of lines and
 * document totals, in exact `Money`. Pure domain unit, no database; cites
 * BI-020, BI-025, BI-045, BI-050, BI-052, BI-057, BI-058, BI-074 and BI-083.
 */

const SERVICE_DATE = parseClinicalDate('2026-05-11');

const resolution = (
  overrides: Partial<ChargeResolution> = {},
): ChargeResolution => ({
  billableServiceId: 'service-1',
  serviceName: 'Consulta de medicina general, primera vez',
  serviceActive: true,
  priceId: 'price-1',
  unitAmount: Money.parse('30.00'),
  taxSriCode: '0',
  taxPercentage: Percentage.ZERO,
  ...overrides,
});

const line = (overrides: Partial<ChargeLine> = {}): ChargeLine => ({
  quantity: Quantity.ONE,
  unitAmount: Money.parse('30.00'),
  discountAmount: Money.ZERO,
  taxPercentage: Percentage.ZERO,
  ...overrides,
});

describe('BI-050 el cargo congela, no referencia', () => {
  it('BI-050 copia importe, nombre, código de impuesto, porcentaje y fila de precio', () => {
    const frozen = freezeCharge(resolution(), SERVICE_DATE, Quantity.ONE);

    expect(frozen.unitAmount.toString()).toBe('30.00');
    expect(frozen.serviceDisplay).toBe(
      'Consulta de medicina general, primera vez',
    );
    expect(frozen.taxSriCode).toBe('0');
    expect(frozen.taxPercentage?.toString()).toBe('0.00');
    // The price row travels BESIDES the amounts and never instead of them: the
    // amounts are what is charged, the identifier is HOW IT IS EXPLAINED.
    expect(frozen.resolvedPriceId).toBe('price-1');
  });

  it('BI-052 toma la fecha del acto que recibe y no la del momento de teclear', () => {
    // A visit from three months ago invoiced today is charged at what applied
    // then. `freezeCharge` has no clock at all, which is what makes that
    // impossible to get wrong.
    const frozen = freezeCharge(resolution(), SERVICE_DATE, Quantity.ONE);
    expect(frozen.serviceDate).toBe(SERVICE_DATE);
  });

  it('BI-025 conserva el porcentaje nulo de «no objeto» y «exento»', () => {
    const frozen = freezeCharge(
      resolution({ taxSriCode: '6', taxPercentage: null }),
      SERVICE_DATE,
      Quantity.ONE,
    );
    // Code 6 is «no objeto de impuesto» and is NOT a synonym of 0%: storing a
    // zero here would make it indistinguishable on form 104.
    expect(frozen.taxSriCode).toBe('6');
    expect(frozen.taxPercentage).toBeNull();
  });

  it('BI-057 rechaza una cantidad de cero o menos', () => {
    expect(() =>
      freezeCharge(resolution(), SERVICE_DATE, Quantity.parse('0')),
    ).toThrow(InvalidChargeQuantityError);
  });
});

describe('BI-058 la aritmética de una línea', () => {
  it('BI-058 calcula cantidad × precio unitario menos descuento', () => {
    const withDiscount = line({
      quantity: Quantity.parse('2'),
      unitAmount: Money.parse('19.99'),
      discountAmount: Money.parse('5.00'),
    });

    expect(lineGross(withDiscount).toString()).toBe('39.98');
    expect(lineBase(withDiscount).toString()).toBe('34.98');
  });

  it('BI-045 calcula el impuesto sobre la base YA DESCONTADA', () => {
    const taxed = line({
      unitAmount: Money.parse('100.00'),
      discountAmount: Money.parse('10.00'),
      taxPercentage: Percentage.parse('15.00'),
    });

    // 15% of 90.00, not of 100.00. Taxing the gross would charge the patient
    // for a discount they were given.
    expect(lineTax(taxed).toString()).toBe('13.50');
  });

  it('BI-058 redondea EN CADA LÍNEA y no una vez al final del total', () => {
    // Three lines of 19.99 at 15%: 2.9985 each. Rounded per line the tax is
    // 3.00 × 3 = 9.00; rounded once at the end it would be 8.99, and the
    // printed lines would not add up to the printed total. The SRI demands the
    // breakdown per item (REQ-083).
    const lines = Array.from({ length: 3 }, () =>
      line({
        unitAmount: Money.parse('19.99'),
        taxPercentage: Percentage.parse('15.00'),
      }),
    );

    expect(totalsOf(lines).taxTotal.toString()).toBe('9.00');
  });

  it('BI-020 no calcula impuesto cuando la tarifa no tiene porcentaje', () => {
    expect(lineTax(line({ taxPercentage: null })).toString()).toBe('0.00');
  });
});

describe('BI-074, BI-083 los totales de un documento', () => {
  it('BI-083 separa la base gravada de la no gravada por la tarifa de CADA línea', () => {
    // A consultation at 0% and a supply at 15%: this document HAS NO single
    // rate, and a total computed with one is wrong in both directions.
    const totals = totalsOf([
      line({
        unitAmount: Money.parse('30.00'),
        taxPercentage: Percentage.ZERO,
      }),
      line({
        unitAmount: Money.parse('20.00'),
        taxPercentage: Percentage.parse('15.00'),
      }),
    ]);

    expect(totals.subtotalUntaxed.toString()).toBe('30.00');
    expect(totals.subtotalTaxed.toString()).toBe('20.00');
    expect(totals.taxTotal.toString()).toBe('3.00');
    expect(totals.total.toString()).toBe('53.00');
  });

  it('BI-074 cuadra con la identidad que exige `invoice_total_is_consistent`', () => {
    // total = subtotal_taxed + subtotal_untaxed + tax_total - discount_total.
    // The subtotals are GROSS and the discount is subtracted once, at the end:
    // computing them net would balance too and would disagree with the column
    // the SRI reads.
    const totals = totalsOf([
      line({
        quantity: Quantity.parse('2'),
        unitAmount: Money.parse('19.99'),
        discountAmount: Money.parse('5.00'),
        taxPercentage: Percentage.parse('15.00'),
      }),
      line({ unitAmount: Money.parse('30.00'), taxPercentage: null }),
    ]);

    const rebuilt = totals.subtotalTaxed
      .plus(totals.subtotalUntaxed)
      .plus(totals.taxTotal)
      .minus(totals.discountTotal);

    expect(totals.total.toString()).toBe(rebuilt.toString());
    expect(totals.discountTotal.toString()).toBe('5.00');
  });

  it('BI-074 devuelve ceros para una cuenta sin cargos', () => {
    const totals = totalsOf([]);
    expect(totals.total.toString()).toBe('0.00');
    expect(totals.taxTotal.toString()).toBe('0.00');
  });
});
