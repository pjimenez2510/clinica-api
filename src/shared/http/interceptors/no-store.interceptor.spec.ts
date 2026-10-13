import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Controller } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { AllowHttpCache, NoStoreInterceptor } from './no-store.interceptor';

/**
 * AU-061. Every response is `no-store` unless the route says otherwise. What
 * is tested: the default, a header the route already declared (kept), and the
 * opt-out on the handler and on the controller (nothing written). Each case
 * carries its own control: the same response object starts empty.
 */
function responseDouble(preset?: string) {
  const headers = new Map<string, string>();
  if (preset !== undefined) headers.set('cache-control', preset);
  return {
    headers,
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
  };
}

function contextOf(
  controller: new () => object,
  handler: () => void,
  response: ReturnType<typeof responseDouble>,
): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const passThrough: CallHandler = { handle: () => of('body') };

describe('ninguna respuesta se guarda en caché salvo la que lo declara', () => {
  const interceptor = new NoStoreInterceptor(new Reflector());

  @Controller()
  class Routes {
    ordinary(this: void): void {}
    @AllowHttpCache()
    cacheable(this: void): void {}
  }

  @Controller()
  @AllowHttpCache()
  class CacheableRoutes {
    any(this: void): void {}
  }

  it('AU-061 sin cabecera previa pone no-store, y deja pasar la respuesta', async () => {
    const response = responseDouble();

    const body = await firstValueFrom(
      interceptor.intercept(
        contextOf(Routes, Routes.prototype.ordinary, response),
        passThrough,
      ),
    );

    expect(body).toBe('body');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('AU-061 una cabecera que la ruta ya declaró se conserva', async () => {
    const response = responseDouble('no-store, private');

    await firstValueFrom(
      interceptor.intercept(
        contextOf(Routes, Routes.prototype.ordinary, response),
        passThrough,
      ),
    );

    expect(response.headers.get('cache-control')).toBe('no-store, private');
  });

  it('AU-061 con @AllowHttpCache() en el handler o en el controlador no escribe nada', async () => {
    const onHandler = responseDouble();
    const onController = responseDouble();

    await firstValueFrom(
      interceptor.intercept(
        contextOf(Routes, Routes.prototype.cacheable, onHandler),
        passThrough,
      ),
    );
    await firstValueFrom(
      interceptor.intercept(
        contextOf(CacheableRoutes, CacheableRoutes.prototype.any, onController),
        passThrough,
      ),
    );

    expect(onHandler.headers.has('cache-control')).toBe(false);
    expect(onController.headers.has('cache-control')).toBe(false);
  });
});
