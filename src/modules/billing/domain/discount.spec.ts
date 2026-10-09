import { describe, expect, it } from 'vitest';

import {
  DiscountExceedsLimitError,
  DiscountNotAuthorisedError,
  DiscountSelfAuthorisationDeniedError,
} from './billing.errors';
import {
  DISCOUNT_OVERRIDE_PERMISSION,
  checkDiscount,
  discountAmountOf,
  strongestLimit,
} from './discount';
import { Money, Percentage } from './money';

const gross = Money.parse('40.00');
const caja = 'user-caja';
const admin = 'user-admin';

describe('BI-062 el límite de quien descuenta', () => {
  it('BI-062 toma el mayor de los límites de sus roles', () => {
    expect(
      strongestLimit([Percentage.parse('5'), Percentage.parse('12.5'), Percentage.parse('10')]).toString(), // prettier-ignore
    ).toBe('12.50');
  });

  it('BI-062 sin ningún límite asignado es cero (BI-141)', () => {
    expect(strongestLimit([]).toString()).toBe('0.00');
  });
});

describe('BI-060 el descuento se congela en dólares en la línea', () => {
  it('BI-060 un porcentaje se convierte a dólares redondeando al centavo', () => {
    expect(
      discountAmountOf({ gross: Money.parse('33.33'), percentage: Percentage.parse('10') }).toString(), // prettier-ignore
    ).toBe('3.33');
  });

  it('BI-060 un importe se guarda tal cual', () => {
    expect(
      discountAmountOf({ gross, amount: Money.parse('4.50') }).toString(),
    ).toBe('4.50');
  });
});

describe('BI-063 BI-064 dentro del límite, o con la autorización de otra persona', () => {
  const ceiling = Percentage.parse('10');

  it('BI-063 dentro del límite entra sin autorizador, y no guarda ninguno', () => {
    expect(
      checkDiscount({
        amount: Money.parse('4.00'),
        gross,
        ceiling,
        appliedById: caja,
        authoriser: { id: admin, permissions: [DISCOUNT_OVERRIDE_PERMISSION] },
      }),
    ).toEqual({ authorisedById: null });
  });

  it('BI-063 el límite se compara en dólares: un 10 % de $0,05 cabe aunque el centavo redondee', () => {
    expect(
      checkDiscount({
        amount: discountAmountOf({ gross: Money.parse('0.05'), percentage: ceiling }), // prettier-ignore
        gross: Money.parse('0.05'),
        ceiling,
        appliedById: caja,
        authoriser: null,
      }),
    ).toEqual({ authorisedById: null });
  });

  it('BI-063 por encima del límite y sin autorizador se rechaza con DISCOUNT_EXCEEDS_LIMIT', () => {
    expect(() =>
      checkDiscount({
        amount: Money.parse('4.01'),
        gross,
        ceiling,
        appliedById: caja,
        authoriser: null,
      }),
    ).toThrow(DiscountExceedsLimitError);
  });

  it('BI-063 por encima del límite entra con otra persona que lleva billing:discount-override', () => {
    expect(
      checkDiscount({
        amount: Money.parse('8.00'),
        gross,
        ceiling,
        appliedById: caja,
        authoriser: { id: admin, permissions: [DISCOUNT_OVERRIDE_PERMISSION] },
      }),
    ).toEqual({ authorisedById: admin });
  });

  it('BI-063 un autorizador sin el permiso en la sede se rechaza con DISCOUNT_NOT_AUTHORISED', () => {
    expect(() =>
      checkDiscount({
        amount: Money.parse('8.00'),
        gross,
        ceiling,
        appliedById: caja,
        authoriser: { id: admin, permissions: ['billing:write'] },
      }),
    ).toThrow(DiscountNotAuthorisedError);
  });

  it('BI-064 quien se nombra a sí mismo se rechaza con SELF_AUTHORISATION_DENIED, aunque lleve el permiso', () => {
    const attempt = () =>
      checkDiscount({
        amount: Money.parse('8.00'),
        gross,
        ceiling,
        appliedById: admin,
        authoriser: { id: admin, permissions: [DISCOUNT_OVERRIDE_PERMISSION] },
      });
    expect(attempt).toThrow(DiscountSelfAuthorisationDeniedError);
    expect(attempt).toThrow(
      expect.objectContaining({ code: 'SELF_AUTHORISATION_DENIED' }),
    );
  });
});
