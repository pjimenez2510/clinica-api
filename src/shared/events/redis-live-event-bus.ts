import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';

import { type LiveEvent, parseLiveEvent } from './live-event';
import {
  LiveEventBus,
  type LiveEventListener,
  ListenerSet,
} from './live-event-bus';

type RedisClient = ReturnType<typeof createClient>;

/**
 * Live events across API instances, over Redis pub/sub (D-187 §1, AU-058).
 *
 * TWO CONNECTIONS, BECAUSE REDIS SAYS SO: a connection in subscriber mode
 * accepts no other command, so the publisher is one client and the
 * subscriber its `duplicate()`. node-redis re-subscribes on its own after a
 * reconnection.
 *
 * AN INSTANCE HEARS ITS OWN EVENTS THROUGH REDIS, not by delivering locally
 * as well: every stream, here or elsewhere, is fed from one place, and an
 * event is never delivered twice.
 *
 * THE PUBLISHER HAS NO OFFLINE QUEUE. With one, a `PUBLISH` while Redis is
 * down waits in memory until it comes back and then fires a burst of stale
 * events; without it, it fails at once — and the event is then delivered to
 * THIS instance's streams, so a single-instance installation loses nothing.
 *
 * DEAF IS SAID, NOT HIDDEN (revisión clínica G1). While either connection is
 * down `healthy()` is false and every stream's heartbeat carries it, so the
 * screens poll every minute again; and when the subscriber is back, the
 * streams are told to read everything again, because what was published in
 * the gap never arrived.
 *
 * Nothing about the event is logged — it carries nothing clinical anyway, but
 * the log line has no reason to know which site changed.
 */
export class RedisLiveEventBus extends LiveEventBus implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLiveEventBus.name);
  private readonly listeners = new ListenerSet();
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;
  private readonly ready: Promise<void>;
  private readonly recovered = new Set<() => void>();
  private everReady = false;
  private subscribed = false;

  constructor(
    url: string,
    private readonly channel: string,
  ) {
    super();
    this.publisher = createClient({ url, disableOfflineQueue: true });
    this.subscriber = this.publisher.duplicate({ disableOfflineQueue: false });
    // An unhandled `error` event on a node-redis client crashes the process.
    // A Redis that went away is a degraded channel, not a dead API.
    this.publisher.on('error', () => this.reportDown('publisher'));
    this.subscriber.on('error', () => this.reportDown('subscriber'));
    // node-redis emits `ready` on the first connection and on every
    // reconnection; re-subscribing is its job, telling the screens is ours.
    this.subscriber.on('ready', () => {
      if (this.everReady) this.recovered.forEach((listener) => listener());
      this.everReady = true;
    });
    this.ready = this.connect();
  }

  /** Resolves once both connections are up and subscribed. For tests. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  publish(event: LiveEvent): void {
    this.publisher.publish(this.channel, JSON.stringify(event)).catch(() => {
      this.reportDown('publish');
      // This instance's own streams still hear it.
      this.listeners.deliver(event);
    });
  }

  override healthy(): boolean {
    return this.subscribed && this.publisher.isReady && this.subscriber.isReady;
  }

  override onRecovered(listener: () => void): () => void {
    this.recovered.add(listener);
    return () => {
      this.recovered.delete(listener);
    };
  }

  subscribe(listener: LiveEventListener): () => void {
    return this.listeners.add(listener);
  }

  onModuleDestroy(): void {
    // `destroy` and not `close`: nothing is pending that must be flushed, and
    // `close` would wait on a Redis that may be the reason we are stopping.
    if (this.subscriber.isOpen) this.subscriber.destroy();
    if (this.publisher.isOpen) this.publisher.destroy();
  }

  private async connect(): Promise<void> {
    try {
      await this.publisher.connect();
      await this.subscriber.connect();
      await this.subscriber.subscribe(this.channel, (message) => {
        const event = parseLiveEvent(message);
        // Something on our channel that is not exactly an event — a stray
        // client, an older version — is dropped, never forwarded.
        if (event) this.listeners.deliver(event);
      });
      this.subscribed = true;
    } catch {
      this.reportDown('connect');
    }
  }

  private lastReport = 0;

  /** At most once a minute: a Redis that is down fails on every retry. */
  private reportDown(stage: string): void {
    const now = Date.now();
    if (now - this.lastReport < 60_000) return;
    this.lastReport = now;
    this.logger.warn({ stage }, 'live events: redis unavailable');
  }
}
