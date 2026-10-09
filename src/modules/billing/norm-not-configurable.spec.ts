import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { BillingModule } from './billing.module';
import {
  createPaymentMethodSchema,
  setDiscountLimitSchema,
  updatePaymentMethodSchema,
} from './dto/billing-parameters.dto';

/**
 * BI-143. THE NORM IS NOT A SETTING.
 *
 * The SRI's tax codes and percentages, the invoice's immutability, the void
 * and credit-note deadlines and «Consumidor Final cannot be voided» are law,
 * not clinic policy. Read from the controllers the module registers and from
 * the bodies the clinic's parameters accept, not from a list someone
 * remembered.
 */
const CONTROLLERS = Reflect.getMetadata(
  MODULE_METADATA.CONTROLLERS,
  BillingModule,
) as (new (...args: never[]) => object)[];

interface Route {
  method: RequestMethod;
  path: string;
}

function routesOf(controller: new (...args: never[]) => object): Route[] {
  const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name];
      if (typeof handler !== 'function') return [];
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof method !== 'number') return [];
      return [
        {
          method,
          path: `${typeof base === 'string' ? base : ''}/${typeof path === 'string' ? path : ''}`,
        },
      ];
    });
}

const routes = CONTROLLERS.flatMap(routesOf);

/** Words a field would carry if it relaxed one of the four. */
const NORM = /tax|iva|void|anul|annul|credit|deadline|immutab|final.?consumer/i;

describe('BI-143 lo que es norma no se configura', () => {
  it('BI-143 las tarifas de IVA del SRI se leen y ninguna ruta del módulo las escribe', () => {
    // Positive control: the module's controllers were found, all of them.
    expect(CONTROLLERS.length).toBeGreaterThanOrEqual(7);
    const taxRateRoutes = routes.filter((route) =>
      route.path.includes('tax-rates'),
    );
    expect(taxRateRoutes).toContainEqual({
      method: RequestMethod.GET,
      path: 'billing/tax-rates',
    });
    expect(
      taxRateRoutes.filter((route) => route.method !== RequestMethod.GET),
    ).toEqual([]);
  });

  it('BI-143 lo que la clínica parametriza en caja no tiene tarifa, plazo ni inmutabilidad que relajar', () => {
    const fields = [
      createPaymentMethodSchema,
      updatePaymentMethodSchema,
      setDiscountLimitSchema,
    ].flatMap((schema) => Object.keys(schema.shape));
    // Positive control: the bodies were read.
    expect(fields).toContain('maxDiscountPercentage');
    expect(fields.filter((field) => NORM.test(field))).toEqual([]);
  });

  it('BI-143 sin ruta para anular una factura no hay plazo de anulación que relajar', () => {
    // D-151.1: voiding is done at the SRI portal. Controls: the credit note
    // route is found, and so is the void of a CHARGE, which the pattern sees.
    const voids = routes.filter((route) => /void|anul/i.test(route.path));
    expect(routes.some((route) => /credit-notes/.test(route.path))).toBe(true);
    expect(voids.some((route) => route.path.includes('/charges/'))).toBe(true);
    expect(voids.filter((route) => route.path.includes('invoices'))).toEqual(
      [],
    );
  });
});
