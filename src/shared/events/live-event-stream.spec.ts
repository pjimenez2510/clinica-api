import type { MessageEvent } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Principal } from '../authorisation/principal';

import { InProcessLiveEventBus } from './live-event-bus';
import { LIVE_RECONNECT_MS, liveEventStream } from './live-event-stream';

const SITE_A = '01990000-0000-7000-8000-00000000000a';
const SITE_B = '01990000-0000-7000-8000-00000000000b';
const HEARTBEAT = 1_000;

function readerAt(siteId: string): Principal {
  return new Principal('01990000-0000-7000-8000-000000000001', [
    { roleCode: 'MEDICO', siteId, permissions: ['record:read'] },
  ]);
}

function open(options: {
  principal?: Principal;
  recheck?: () => Promise<Principal | null>;
  lifetimeMs?: number;
}) {
  const bus = new InProcessLiveEventBus();
  const received: MessageEvent[] = [];
  let completed = false;
  const principal = options.principal ?? readerAt(SITE_A);
  const subscription = liveEventStream({
    bus,
    principal,
    recheck: options.recheck ?? (() => Promise.resolve(principal)),
    lifetimeMs: options.lifetimeMs ?? 60_000,
    heartbeatMs: HEARTBEAT,
  }).subscribe({
    next: (message) => received.push(message),
    complete: () => {
      completed = true;
    },
  });
  return {
    bus,
    received,
    subscription,
    completed: () => completed,
    types: () => received.map((message) => message.type),
  };
}

describe('el flujo de avisos en vivo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AU-054: abre con `ready` y su espera de reconexión, y late cada intervalo', async () => {
    const stream = open({});

    expect(stream.received[0]).toMatchObject({
      type: 'ready',
      retry: LIVE_RECONNECT_MS,
      data: { degraded: false },
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2);

    expect(stream.types()).toEqual(['ready', 'heartbeat', 'heartbeat']);
    stream.subscription.unsubscribe();
  });

  it('AU-055, AU-056: entrega sólo los avisos de su sede, con tipo y sede y nada más', () => {
    const stream = open({ principal: readerAt(SITE_A) });

    stream.bus.publish({ kind: 'critical-results', siteId: SITE_B });
    stream.bus.publish({ kind: 'critical-results', siteId: SITE_A });

    expect(stream.received.slice(1)).toEqual([
      {
        type: 'critical-results',
        data: { kind: 'critical-results', siteId: SITE_A },
      },
    ]);
    stream.subscription.unsubscribe();
  });

  it('AU-056: los permisos se resuelven de nuevo en cada latido', async () => {
    let now = readerAt(SITE_A);
    const stream = open({
      principal: now,
      recheck: () => Promise.resolve(now),
    });

    now = readerAt(SITE_B);
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    stream.bus.publish({ kind: 'critical-results', siteId: SITE_A });
    stream.bus.publish({ kind: 'critical-results', siteId: SITE_B });

    expect(
      stream.received
        .filter((message) => message.type === 'critical-results')
        .map((message) => (message.data as { siteId: string }).siteId),
    ).toEqual([SITE_B]);
    stream.subscription.unsubscribe();
  });

  it('AU-057: se corta en el latido tras cerrarse la sesión, y también si no se puede comprobar', async () => {
    let open_ = true;
    const closed = open({
      recheck: () => Promise.resolve(open_ ? readerAt(SITE_A) : null),
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(closed.completed()).toBe(false);

    open_ = false;
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(closed.completed()).toBe(true);

    const failing = open({
      recheck: () => Promise.reject(new Error('database down')),
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(failing.completed()).toBe(true);
  });

  it('AU-057: se corta al caducar el token con que se abrió, y deja de oír el bus', async () => {
    const stream = open({ lifetimeMs: HEARTBEAT / 2 });

    await vi.advanceTimersByTimeAsync(HEARTBEAT / 2);
    stream.bus.publish({ kind: 'critical-results', siteId: SITE_A });

    expect(stream.completed()).toBe(true);
    expect(stream.types()).toEqual(['ready']);
  });

  it('AU-057: un token ya caducado no abre un flujo que dure', async () => {
    const stream = open({ lifetimeMs: -5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.completed()).toBe(true);
  });

  it('AU-058 cada latido lleva la hora del servidor y si el bus está sordo; al volver el bus, pide releer', async () => {
    let healthy = true;
    const recovered: (() => void)[] = [];
    class FlakyBus extends InProcessLiveEventBus {
      override healthy(): boolean {
        return healthy;
      }
      override onRecovered(listener: () => void): () => void {
        recovered.push(listener);
        return () => undefined;
      }
    }
    const bus = new FlakyBus();
    const received: MessageEvent[] = [];
    const subscription = liveEventStream({
      bus,
      principal: readerAt(SITE_A),
      recheck: () => Promise.resolve(readerAt(SITE_A)),
      lifetimeMs: 60_000,
      heartbeatMs: HEARTBEAT,
    }).subscribe((message) => received.push(message));

    healthy = false;
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    const beat = received.at(-1)!;
    expect(beat.type).toBe('heartbeat');
    expect(beat.data).toEqual({
      now: new Date().toISOString(),
      degraded: true,
    });

    healthy = true;
    for (const listener of recovered) listener();
    expect(received.at(-1)).toMatchObject({
      type: 'resync',
      data: { degraded: false },
    });
    subscription.unsubscribe();
  });

  it('el registro puede terminar el flujo desde fuera, y lo olvida al cerrarse', () => {
    let end: (() => void) | undefined;
    let forgotten = false;
    let completed = false;
    liveEventStream({
      bus: new InProcessLiveEventBus(),
      principal: readerAt(SITE_A),
      recheck: () => Promise.resolve(readerAt(SITE_A)),
      lifetimeMs: 60_000,
      register: (fn) => {
        end = fn;
        return () => {
          forgotten = true;
        };
      },
    }).subscribe({ complete: () => (completed = true) });

    end?.();
    expect(completed).toBe(true);
    expect(forgotten).toBe(true);
  });
});
