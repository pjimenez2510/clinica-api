import type { LiveEvent } from './live-event';

export type LiveEventListener = (event: LiveEvent) => void;

/**
 * Where live events are published and heard (D-187, AU-058).
 *
 * An abstract class and not an interface so it doubles as its own Nest
 * injection token: the modules that publish (`orders`) and the route that
 * streams (`auth`) both depend on this and on nothing else.
 *
 * `publish` NEVER THROWS AND RETURNS NOTHING TO AWAIT. It is called after a
 * clinical write has committed; a failure here must not turn a saved critical
 * notice into a 500, nor make anybody retry a write that already happened.
 * Losing an event leaves the screen as it was before D-187, with its fallback
 * polling (ORD-166).
 */
export abstract class LiveEventBus {
  abstract publish(event: LiveEvent): void;

  /** Returns the function that stops listening. */
  abstract subscribe(listener: LiveEventListener): () => void;

  /**
   * Whether events published ANYWHERE are reaching this instance now.
   *
   * A stream whose browser connection is alive can still be deaf: the broker
   * dropped, and nothing published meanwhile will ever arrive. The stream says
   * so on every heartbeat, and the screen goes back to polling every minute
   * (ORD-166, revisión clínica G1).
   */
  healthy(): boolean {
    return true;
  }

  /**
   * Called each time the bus comes back after being deaf: whatever was
   * published in the gap is lost, so the streams tell their screens to read
   * everything again. Returns the function that stops listening.
   */
  onRecovered(listener: () => void): () => void {
    void listener;
    return () => undefined;
  }
}

/**
 * Delivers to every listener, isolating them: one listener that throws must
 * not keep the event from the others.
 */
export class ListenerSet {
  private readonly listeners = new Set<LiveEventListener>();

  add(listener: LiveEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  deliver(event: LiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A stream that failed to write is that stream's problem; Nest closes
        // it. The others still get the event.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

/**
 * One API instance, no Redis: events circulate inside the process. What runs
 * in development without `REDIS_URL` and in the integration suite.
 */
export class InProcessLiveEventBus extends LiveEventBus {
  private readonly listeners = new ListenerSet();

  publish(event: LiveEvent): void {
    this.listeners.deliver(event);
  }

  subscribe(listener: LiveEventListener): () => void {
    return this.listeners.add(listener);
  }
}
