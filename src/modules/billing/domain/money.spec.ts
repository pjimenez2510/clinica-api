import { describe, expect, it } from 'vitest';

import { Money, Percentage, Quantity } from './money';

/**
 * BI-001. Money is exact or it is a tax defect.
 *
 * These are the assertions that would fail the day somebody «simplifies»
 * `Money` into a `number`: every one of them is a value IEEE-754 gets wrong.
 */
describe('BI-001 el dinero es decimal exacto y nunca coma flotante', () => {
  it('BI-001 suma 0.10 y 0.20 y da exactamente 0.30', () => {
    // `0.1 + 0.2 === 0.30000000000000004` in binary floating point. This is
    // the canonical example and it is also a real invoice line.
    expect(Money.parse('0.10').plus(Money.parse('0.20')).toString()).toBe(
      '0.30',
    );
  });

  it('BI-001 conserva los centavos al leer y volver a escribir un importe', () => {
    for (const amount of ['0.01', '19.90', '1234567.89', '0.00']) {
      expect(Money.parse(amount).toString()).toBe(amount);
    }
  });

  it('BI-001 lee un `Decimal` del controlador sin pasar por `number`', () => {
    // The shape `Prisma.Decimal` satisfies: `toFixed(2)` returns a string, and
    // that string is what is parsed. No `Number()` anywhere on the path.
    const fromDriver = { toFixed: (digits: number) => (9.95).toFixed(digits) };
    expect(Money.parse(fromDriver).toString()).toBe('9.95');
  });

  it('BI-001 rechaza un importe con más de dos decimales en vez de redondearlo', () => {
    // Silently rounding is how a client sends `19.899999` and is charged
    // `19.90` without ever being told.
    expect(() => Money.parse('19.899')).toThrow(RangeError);
  });

  it('BI-001 suma cien líneas de un centavo y da exactamente un dólar', () => {
    const cents = Array.from({ length: 100 }, () => Money.parse('0.01'));
    expect(Money.sum(cents).toString()).toBe('1.00');
  });

  it('BI-058 multiplica por una cantidad con tres decimales redondeando al centavo', () => {
    // Half a vial of something that costs 15.15: 7.575 rounds up to 7.58.
    expect(Money.parse('15.15').times(Quantity.parse('0.5')).toString()).toBe(
      '7.58',
    );
    expect(Money.parse('30.00').times(Quantity.parse('3')).toString()).toBe(
      '90.00',
    );
  });

  it('BI-058 aplica el porcentaje sobre la base y redondea al centavo', () => {
    // 15% of 19.99 is 2.9985, which is 3.00 on the invoice and 2.9985 in a
    // float. The SRI reads the printed figure.
    expect(
      Money.parse('19.99').percentageOf(Percentage.parse('15.00')).toString(),
    ).toBe('3.00');
    // 0% is a real rate and yields exactly zero, not «almost zero».
    expect(Money.parse('30.00').percentageOf(Percentage.ZERO).toString()).toBe(
      '0.00',
    );
  });

  it('BI-043 distingue cero de negativo, porque cero es un precio real', () => {
    expect(Money.parse('0.00').isNegative()).toBe(false);
    expect(Money.parse('0.00').isZero()).toBe(true);
    expect(Money.parse('10.00').minus(Money.parse('10.01')).isNegative()).toBe(
      true,
    );
  });

  it('BI-057 admite tres decimales de cantidad y rechaza cero o menos', () => {
    // The column is `numeric(10,3)` and `charge_item_quantity_is_positive` is
    // the guarantee: consumables are dispensed in fractions.
    expect(Quantity.parse('0.500').isPositive()).toBe(true);
    expect(Quantity.parse('0').isPositive()).toBe(false);
    expect(Quantity.parse('-1').isPositive()).toBe(false);
  });

  it('BI-020 lee un porcentaje nulo como ausencia y no como cero', () => {
    // «No objeto» and «exento» have NO percentage, and they are not synonyms
    // of 0%: the three produce zero tax and mean three different things on
    // form 104. The absence is modelled as `null` by the caller; what this
    // asserts is that `Percentage.ZERO` is a real zero and not a stand-in.
    expect(Percentage.ZERO.isZero()).toBe(true);
    expect(Percentage.parse('15.00').isZero()).toBe(false);
    expect(Percentage.parse('12.00').toString()).toBe('12.00');
  });
});

describe('BI-001 los bordes de la aritmética exacta', () => {
  it('BI-001 formatea y compara importes negativos, que existen al restar', () => {
    // A negative Money is never stored — `price_is_not_negative` and
    // `charge_item_amount_is_not_negative` refuse it — but it exists for an
    // instant while a total is composed, and a formatter that got the sign
    // wrong would print it on a screen.
    const owed = Money.parse('10.00').minus(Money.parse('25.50'));

    expect(owed.toString()).toBe('-15.50');
    expect(owed.isNegative()).toBe(true);
    expect(Money.parse('-15.50').equals(owed)).toBe(true);
  });

  it('BI-095 compara importes sin pasar por coma flotante', () => {
    // The comparison a credit note will need: «lo acreditado no supera la
    // factura». `0.1 + 0.2 > 0.3` is TRUE in binary floating point.
    const twoTenths = Money.parse('0.10').plus(Money.parse('0.20'));

    expect(twoTenths.isGreaterThan(Money.parse('0.30'))).toBe(false);
    expect(twoTenths.equals(Money.parse('0.30'))).toBe(true);
    expect(Money.parse('0.31').isGreaterThan(Money.parse('0.30'))).toBe(true);
  });

  it('BI-001 rechaza lo que no es un importe en vez de leerlo como cero', () => {
    // Reaching this means a value that never was money got to a boundary. A
    // silent zero there is a line that stops being charged.
    for (const notAnAmount of ['', 'treinta', '1,50', '1e3', '10.']) {
      expect(() => Money.parse(notAnAmount)).toThrow(RangeError);
    }
  });

  it('BI-057 rechaza una cantidad con más de tres decimales', () => {
    // `numeric(10,3)`: a fourth decimal would be rounded by PostgreSQL without
    // telling anybody, and the line total would not match what was sent.
    expect(() => Quantity.parse('0.5005')).toThrow(RangeError);
    expect(Quantity.ONE.toString()).toBe('1.000');
  });

  it('BI-020 formatea el porcentaje con sus dos decimales', () => {
    expect(Percentage.parse({ toFixed: () => '15.00' }).toString()).toBe('15.00'); // prettier-ignore
    expect(Percentage.ZERO.toString()).toBe('0.00');
  });
});
