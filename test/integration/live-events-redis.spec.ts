import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LiveEvent } from '../../src/shared/events/live-event';
import { RedisLiveEventBus } from '../../src/shared/events/redis-live-event-bus';

/**
 * AU-058 against a real Redis: what one API instance publishes reaches the
 * streams of another, on the installation's own channel and only there.
 *
 * A real broker because the property is the broker's: a double that hands
 * the message to the other bus proves only that the double does.
 */
const SITE_A = '01990000-0000-7000-8000-00000000000a';
const SITE_B = '01990000-0000-7000-8000-00000000000b';

describe('los avisos en vivo entre instancias, por Redis', () => {
  let redis: StartedTestContainer;
  let url: string;
  const buses: RedisLiveEventBus[] = [];

  beforeAll(async () => {
    redis = await new GenericContainer('redis:8-alpine')
      .withExposedPorts(6379)
      .start();
    url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  });

  afterAll(async () => {
    for (const bus of buses) bus.onModuleDestroy();
    await redis?.stop();
  });

  async function instance(channel: string): Promise<{
    bus: RedisLiveEventBus;
    heard: LiveEvent[];
  }> {
    const bus = new RedisLiveEventBus(url, channel);
    buses.push(bus);
    await bus.whenReady();
    const heard: LiveEvent[] = [];
    bus.subscribe((event) => heard.push(event));
    return { bus, heard };
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('AU-058: lo que publica una instancia llega a las demás de su canal, una vez, y no a otra instalación', async () => {
    const one = await instance('clinica:test:live-events');
    const two = await instance('clinica:test:live-events');
    const other = await instance('otra-clinica:live-events');

    one.bus.publish({ kind: 'critical-results', siteId: SITE_A });
    other.bus.publish({ kind: 'critical-results', siteId: SITE_B });

    // Control positivo: la otra instalación oye lo suyo, así que tuvo tiempo
    // de oír lo de la primera si le llegara.
    await until(() => other.heard.length === 1);
    await until(() => one.heard.length === 1 && two.heard.length === 1);
    expect(two.heard).toEqual([{ kind: 'critical-results', siteId: SITE_A }]);
    // An instance hears its own events through Redis, and only once.
    expect(one.heard).toEqual([{ kind: 'critical-results', siteId: SITE_A }]);
    expect(other.heard).toEqual([{ kind: 'critical-results', siteId: SITE_B }]);
  });

  it('AU-055: lo que llega al canal y no es exactamente un aviso no se entrega', async () => {
    const listener = await instance('clinica:test:strict');
    const intruder = await instance('clinica:test:strict');

    // Through the client directly: what a stray publisher could put there.
    await (
      intruder.bus as unknown as {
        publisher: { publish: (c: string, m: string) => Promise<number> };
      }
    ).publisher.publish(
      'clinica:test:strict',
      JSON.stringify({ kind: 'critical-results', siteId: SITE_A, value: 6.9 }),
    );
    intruder.bus.publish({ kind: 'critical-results', siteId: SITE_B });

    await until(() => listener.heard.length >= 1);
    expect(listener.heard).toEqual([
      { kind: 'critical-results', siteId: SITE_B },
    ]);
  });

  it('AU-058: con Redis caído, publicar no lanza', async () => {
    const down = new RedisLiveEventBus(
      'redis://127.0.0.1:1',
      'clinica:test:down',
    );
    buses.push(down);

    expect(() =>
      down.publish({ kind: 'critical-results', siteId: SITE_A }),
    ).not.toThrow();
    // Control positivo: un bus con Redis vivo sí entrega por el mismo camino.
    const alive = await instance('clinica:test:down');
    alive.bus.publish({ kind: 'critical-results', siteId: SITE_A });
    await until(() => alive.heard.length === 1);
  });
});
