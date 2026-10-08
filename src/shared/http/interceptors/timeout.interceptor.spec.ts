import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, NEVER, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_TIMEOUT, Timeout, TimeoutInterceptor } from './timeout.interceptor';

/**
 * AU-054 (revisión clínica M3). The live-events stream is the one response
 * MEANT to stay open, and the 15 s cut would end it before its first
 * heartbeat. What is tested: `NO_TIMEOUT` lifts the cut, and a route without
 * it still has it (the control).
 */
function contextOf(handler: () => void): ExecutionContext {
  return { getHandler: () => handler } as unknown as ExecutionContext;
}

describe('el corte de 15 s', () => {
  const interceptor = new TimeoutInterceptor(new Reflector());

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('AU-054 con NO_TIMEOUT la respuesta sigue abierta pasado el plazo; sin él, se corta', async () => {
    class Routes {
      @Timeout(NO_TIMEOUT)
      stream(this: void): void {}
      ordinary(this: void): void {}
    }
    const late: CallHandler = {
      handle: () => timer(60_000).pipe(map(() => 'late')),
    };

    const open = firstValueFrom(
      interceptor.intercept(contextOf(Routes.prototype.stream), late),
    );
    const cut = firstValueFrom(
      interceptor.intercept(contextOf(Routes.prototype.ordinary), {
        handle: () => NEVER,
      }),
    );
    const cutError = cut.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(open).resolves.toBe('late');
    expect(await cutError).toMatchObject({ status: 408 });
  });
});
