import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';

import type { Principal } from '../authorisation/principal';

import { mayReceive } from './live-event';
import type { LiveEventBus } from './live-event-bus';

/** AU-054. Under the 30 s most proxies give an idle connection. */
export const LIVE_HEARTBEAT_MS = 20_000;

/**
 * Injection token for the heartbeat, so the integration suite can watch a
 * stream close in milliseconds instead of waiting twenty seconds (AU-057).
 */
export const LIVE_HEARTBEAT = Symbol('LIVE_HEARTBEAT');

/**
 * Sent once, first: how long the browser waits before reconnecting after the
 * stream ends. Short, because the stream ENDS ON PURPOSE when the access token
 * expires (AU-057) and the screen should be back within seconds.
 */
export const LIVE_RECONNECT_MS = 3_000;

/** A token is 15 minutes; nothing legitimate keeps a stream for a day. */
const MAX_LIFETIME_MS = 86_400_000;

export interface LiveStreamOptions {
  bus: LiveEventBus;
  /** The caller as the guards resolved it when the stream opened. */
  principal: Principal;
  /**
   * AU-056, AU-057. Asked on every heartbeat: the caller as they are NOW, or
   * `null` when the session is over — closed, revoked, expired, or no longer
   * holding what the route demands. A failure to answer counts as `null`:
   * a stream that cannot confirm its session closes, and the reconnection
   * goes through the guards again.
   */
  recheck: () => Promise<Principal | null>;
  /** AU-057. Until the access token it was opened with expires. */
  lifetimeMs: number;
  heartbeatMs?: number;
}

/**
 * The stream behind `GET /events` (D-187).
 *
 * WHAT THE BROWSER RECEIVES: one `ready` with the reconnection delay, then
 * only the events whose kind and site this caller may read (AU-056), each as
 * `{ kind, siteId }` and nothing else (AU-055), and a `heartbeat` every
 * `heartbeatMs` so no proxy closes it as idle.
 *
 * IT ENDS BY ITSELF, AND THAT IS THE POINT (AU-057): when the access token
 * expires, and on the first heartbeat after the session closed. Without that,
 * an open stream would outlive «Cerrar sesión» and the deactivation of the
 * account — the half-closed session AU-036 removed from ordinary requests.
 */
export function liveEventStream(
  options: LiveStreamOptions,
): Observable<MessageEvent> {
  const heartbeatMs = options.heartbeatMs ?? LIVE_HEARTBEAT_MS;

  return new Observable<MessageEvent>((subscriber) => {
    let principal = options.principal;
    let checking = false;

    subscriber.next({ type: 'ready', retry: LIVE_RECONNECT_MS, data: {} });

    const stopListening = options.bus.subscribe((event) => {
      if (!mayReceive(principal, event)) return;
      // Rebuilt field by field, never the object as it arrived: what the
      // browser receives is exactly the two fields AU-055 allows.
      subscriber.next({
        type: event.kind,
        data: { kind: event.kind, siteId: event.siteId },
      });
    });

    const heartbeat = setInterval(() => {
      // One check at a time: a slow database must not stack them.
      if (checking) return;
      checking = true;
      options
        .recheck()
        .catch(() => null)
        .then((current) => {
          checking = false;
          if (subscriber.closed) return;
          if (!current) {
            subscriber.complete();
            return;
          }
          principal = current;
          subscriber.next({ type: 'heartbeat', data: {} });
        })
        .catch(() => undefined);
    }, heartbeatMs);

    const expiry = setTimeout(
      () => subscriber.complete(),
      // Clamped: `setTimeout` overflows past ~24.8 days and fires at once.
      Math.min(Math.max(0, options.lifetimeMs), MAX_LIFETIME_MS),
    );

    return () => {
      stopListening();
      clearInterval(heartbeat);
      clearTimeout(expiry);
    };
  });
}
