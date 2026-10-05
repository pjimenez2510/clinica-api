import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { OrdersModule } from '../../src/modules/orders/orders.module';
import {
  REQUIRED_PERMISSION_KEY,
  SITE_SCOPE_KEY,
} from '../../src/shared/http/auth.decorators';

import { closeApp } from './setup/http-server';

/**
 * The permission table of this module, read off the routes NestJS actually
 * registered.
 *
 * `route-authorisation.spec.ts` already fails when ANY route in the system
 * forgets to declare a permission. What it cannot say is WHICH permission each
 * of these declares, and that is the whole content of ORD-094: transcribing a
 * laboratory report must not require `record:write`, because `record:write` is
 * what lets somebody DIAGNOSE (art. 198 de la Ley Orgánica de Salud). A
 * regression there would be invisible to the general test and would quietly
 * hand every transcriber the ability to code a diagnosis.
 *
 * IT ASSERTS THE WHOLE TABLE AND NOT A SAMPLE, so that a route ADDED later
 * fails here until somebody writes down which key it needs. The declaration of
 * a new endpoint's permission is meant to be a line in a diff a person reads.
 */
describe('las rutas del módulo de órdenes', () => {
  let app: INestApplication | undefined;
  let routes: { path: string; method: string; permission: unknown; siteScope: unknown }[]; // prettier-ignore

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const container = moduleRef.get(ModulesContainer, { strict: false });
    routes = [];

    for (const module of container.values()) {
      if (module.metatype !== OrdersModule) continue;

      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype as (new () => object) | undefined;
        if (!metatype) continue;

        for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
          if (name === 'constructor') continue;
          const handler = (metatype.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;

          const path: unknown = Reflect.getMetadata('path', handler);
          if (path === undefined) continue;

          const controllerPath: unknown = Reflect.getMetadata('path', metatype);
          const method: unknown = Reflect.getMetadata('method', handler);

          routes.push({
            path: `/${[controllerPath, path]
              .map((part) => (typeof part === 'string' ? part : ''))
              .flatMap((part) => part.split('/'))
              .filter((segment) => segment !== '' && segment !== '/')
              .join('/')}`,
            method: METHODS[method as number] ?? String(method),
            permission: Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler),
            siteScope: Reflect.getMetadata(SITE_SCOPE_KEY, handler),
          });
        }
      }
    }

    // If the walk finds nothing, every assertion below passes vacuously.
    expect(routes.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('ORD-090, ORD-094 y ORD-062 declaran exactamente esta tabla de permisos', () => {
    const table = routes
      .map((r) => `${r.method} ${r.path} → ${String(r.permission)}`)
      .sort();

    expect(table).toEqual(
      [
        'POST /encounters/:encounterId/orders → record:write',
        'GET /encounters/:encounterId/orders → record:read',
        'GET /orders/pending → record:read',
        'GET /orders/:orderId → record:read',
        'POST /orders/:orderId/items/:itemId/cancel → record:write',
        // ORD-096, ORD-098, ORD-099. El borrador: corregirlo, emitirlo y
        // descartarlo son pedir, con el permiso de pedir.
        'PUT /orders/:orderId → record:write',
        'POST /orders/:orderId/issue → record:write',
        'POST /orders/:orderId/discard → record:write',
        'GET /orders/results/unmatched → record:read',
        'POST /orders/results/:resultId/match → result:write',
        'GET /orders/results/critical → record:read',
        // ORD-062. Avisar lo registra quien transcribe, no quien diagnostica (D-111 §6).
        'POST /orders/results/:resultId/notices → result:write',
        'POST /orders/reports/:reportId/correct → result:write',
        'POST /orders/:orderId/reports → result:write',
        'GET /orders/:orderId/reports → record:read',
        'GET /exams → catalog:read',
      ].sort(),
    );
  });

  it('ORD-094 no deja que transcribir un resultado exija poder diagnosticar', () => {
    // `record:write` es lo que permite registrar un diagnóstico. Quien teclea
    // un informe de laboratorio puede ser un técnico o el personal de
    // admisiones, y el art. 198 obliga a «limitar sus acciones al área que el
    // título les asigne».
    const writing = routes.filter(
      (route) => route.path.includes('reports') && route.method === 'POST',
    );

    expect(writing).toHaveLength(2);
    for (const route of writing) {
      expect(route.permission, route.path).toBe('result:write');
    }
  });

  it('ORD-043 y ORD-094 emparejar un resultado escribe, y no exige diagnosticar', () => {
    // Leer la cola es `record:read`; emparejar ESCRIBE el expediente y puede
    // cerrar una línea de la cola de pendientes, así que lleva la llave del
    // transcriptor. Y nunca `record:write`: emparejar no es diagnosticar.
    const match = routes.find((route) => route.path.endsWith('/match'));

    expect(match?.method).toBe('POST');
    expect(match?.permission).toBe('result:write');
  });

  it('ORD-090 declara alcance por sede en todo lo que toca una historia', () => {
    // `'query'` y no `param:` porque la sede de una orden es la de su atención
    // y no está en la URL: el guard no puede comprobar lo que no ve, así que
    // el manejador estrecha con el alcance resuelto de quien llama.
    for (const route of routes) {
      const expected = route.path === '/exams' ? 'global' : 'query';
      expect(route.siteScope, route.path).toBe(expected);
    }
  });

  it('ORD-080 no expone ninguna ruta que cree, busque o modifique un paciente', () => {
    // Se cumple POR AUSENCIA: crear ficha desde un resultado es la causa
    // principal de fichas duplicadas en los sistemas que lo hacen al revés.
    for (const route of routes) {
      expect(route.path, route.path).not.toContain('patients');
    }
  });
});

/** `RequestMethod` as NestJS numbers it. */
const METHODS: Record<number, string> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
};
