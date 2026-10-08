import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';

import { InProcessLiveEventBus, LiveEventBus } from './live-event-bus';
import { LIVE_HEARTBEAT, LIVE_HEARTBEAT_MS } from './live-event-stream';
import { RedisLiveEventBus } from './redis-live-event-bus';

/**
 * The live-events bus, for whoever publishes and whoever streams (D-187).
 *
 * Global because it is infrastructure, like `PrismaService`: `orders`
 * publishes and `auth` streams, and neither may import the other.
 *
 * WITH `REDIS_URL`, REDIS; WITHOUT IT, THE PROCESS (AU-058). Redis is what
 * lets an event written on one instance reach a stream held by another; on a
 * single instance — development, the integration suite — the process is the
 * whole world and needs no broker.
 */
@Global()
@Module({
  providers: [
    {
      provide: LiveEventBus,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): LiveEventBus => {
        const url = config.get('REDIS_URL', { infer: true });
        if (!url) return new InProcessLiveEventBus();
        return new RedisLiveEventBus(
          url,
          config.get('LIVE_EVENTS_CHANNEL', { infer: true }),
        );
      },
    },
    { provide: LIVE_HEARTBEAT, useValue: LIVE_HEARTBEAT_MS },
  ],
  exports: [LiveEventBus, LIVE_HEARTBEAT],
})
export class LiveEventsModule {}
