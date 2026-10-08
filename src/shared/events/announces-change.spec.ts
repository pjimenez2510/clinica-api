import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  ANNOUNCES_CHANGE_KEY,
  AnnounceChangeInterceptor,
} from './announces-change';
import type { LiveEvent } from './live-event';
import { InProcessLiveEventBus } from './live-event-bus';

const SITE = '01990000-0000-7000-8000-00000000000a';

function contextFor(request: {
  method: string;
  params: Record<string, string>;
}): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ANNOUNCES_CHANGE_KEY, ['agenda', 'waiting-room'], handler); // prettier-ignore
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function setUp() {
  const bus = new InProcessLiveEventBus();
  const heard: LiveEvent[] = [];
  bus.subscribe((event) => heard.push(event));
  return { interceptor: new AnnounceChangeInterceptor(new Reflector(), bus), heard }; // prettier-ignore
}

const answers = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('AnnouncesChange', () => {
  it('AG-179: una escritura que termina bien publica cada tipo para la sede de la ruta, y nada más', async () => {
    const { interceptor, heard } = setUp();
    const context = contextFor({ method: 'POST', params: { siteId: SITE, entryId: 'x' } }); // prettier-ignore

    await lastValueFrom(interceptor.intercept(context, answers({ id: 'e' })));

    expect(heard).toEqual([
      { kind: 'agenda', siteId: SITE },
      { kind: 'waiting-room', siteId: SITE },
    ]);
  });

  it('AG-179: una escritura que falla no publica nada', async () => {
    const { interceptor, heard } = setUp();
    const context = contextFor({ method: 'PATCH', params: { siteId: SITE } });

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('SLOT_TAKEN')),
        }),
      ),
    ).rejects.toThrow('SLOT_TAKEN');
    expect(heard).toEqual([]);
  });

  it('AG-179: una lectura no publica, y una sede que no es un uuid tampoco', async () => {
    const { interceptor, heard } = setUp();

    await lastValueFrom(
      interceptor.intercept(
        contextFor({ method: 'GET', params: { siteId: SITE } }),
        answers([]),
      ),
    );
    await lastValueFrom(
      interceptor.intercept(
        contextFor({ method: 'POST', params: { siteId: 'norte' } }),
        answers({}),
      ),
    );

    expect(heard).toEqual([]);
  });

  it('AG-179: en la clase y en el método a la vez, la escritura se anuncia una sola vez', async () => {
    const { interceptor, heard } = setUp();
    const context = contextFor({ method: 'POST', params: { siteId: SITE } });
    const inner: CallHandler = {
      handle: () => interceptor.intercept(context, answers({})),
    };

    await lastValueFrom(interceptor.intercept(context, inner));

    expect(heard).toHaveLength(2);
  });
});
