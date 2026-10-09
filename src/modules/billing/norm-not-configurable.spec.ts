import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { BillingCatalogueController } from './billing-catalogue.controller';
import { BillingParametersController } from './billing-parameters.controller';
import { BillingController } from './billing.controller';
import { CashController } from './cash.controller';
import { CreditNoteController } from './credit-note.controller';
import {
  PublicTariffController,
  TariffPublicationController,
} from './tariff-publication.controller';

/**
 * BI-143. WHAT IS THE NORM IS NOT A SETTING.
 *
 * The SRI's tax codes and percentages, the invoice's immutability, the void
 * and credit-note deadlines and «Consumidor Final cannot be voided» are law,
 * not clinic policy. Read from the routes Nest actually serves, not from a
 * list someone remembered.
 */
const CONTROLLERS = [
  BillingCatalogueController,
  BillingParametersController,
  BillingController,
  CashController,
  CreditNoteController,
  TariffPublicationController,
  PublicTariffController,
];

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

/** Words a parameter would carry if it relaxed one of the four. */
const NORM = /tax|iva|void|anul|annul|credit|immutab|final.?consumer/i;

describe('BI-143 lo que es norma no se configura', () => {
  it('BI-143 las tarifas de IVA del SRI se leen y ninguna ruta las escribe', () => {
    const taxRateRoutes = routes.filter((route) =>
      route.path.includes('tax-rates'),
    );
    // Positive control: the read route is found, so the walk sees routes.
    expect(taxRateRoutes).toContainEqual({
      method: RequestMethod.GET,
      path: 'billing/tax-rates',
    });
    expect(
      taxRateRoutes.filter((route) => route.method !== RequestMethod.GET),
    ).toEqual([]);
  });

  it('BI-143 lo que la clínica parametriza no toca tarifas, plazos ni inmutabilidad', () => {
    const settings = routesOf(BillingParametersController);
    // Positive control: the clinic's own parameters are found.
    expect(settings.some((route) => route.path.includes('payment-methods'))).toBe(true); // prettier-ignore
    expect(settings.filter((route) => NORM.test(route.path))).toEqual([]);
  });

  it('BI-143 el sistema no ofrece anular una factura: corregir es la nota de crédito', () => {
    // D-151.1: voiding is done at the SRI portal; no route does it here, so
    // no deadline of it can be relaxed. Controls: the credit note route is
    // found, and so is the void of a CHARGE, which the pattern does see.
    const voids = routes.filter((route) => /void|anul/i.test(route.path));
    expect(routes.some((route) => /credit-notes/.test(route.path))).toBe(true);
    expect(voids.some((route) => route.path.includes('/charges/'))).toBe(true);
    expect(voids.filter((route) => route.path.includes('invoices'))).toEqual(
      [],
    );
  });
});
