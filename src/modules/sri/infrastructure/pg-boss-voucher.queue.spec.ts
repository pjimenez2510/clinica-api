import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../shared/config/env.schema';
import type {
  JobQueue,
  PgBossConnection,
} from '../../../shared/infrastructure/queue/pg-boss.connection';

import { PgBossVoucherQueue, SriQueues } from './pg-boss-voucher.queue';

const VOUCHER = '01990000-0000-7000-8000-0000000000f1';

/**
 * A connection that hands out recording handles; `failOnce` names a queue
 * whose first declaration fails, as when the database drops mid start-up.
 */
function fakeConnection(failOnce?: string) {
  const declared: string[] = [];
  const sent: { name: string; data: unknown; options: unknown }[] = [];
  let failed = false;
  const connection = {
    declareQueue: (name: string) => {
      if (name === failOnce && !failed) {
        failed = true;
        return Promise.reject(new Error('ECONNRESET'));
      }
      if (declared.includes(name)) {
        return Promise.reject(new Error(`"${name}" is declared twice`));
      }
      declared.push(name);
      const queue: Partial<JobQueue<unknown>> = {
        name,
        send: (data, options) => {
          sent.push({ name, data, options });
          return Promise.resolve();
        },
      };
      return Promise.resolve(queue);
    },
  } as unknown as PgBossConnection;
  return { connection, declared, sent };
}

const enabled = {
  get: () => true,
} as unknown as ConfigService<Env, true>;
const silent = { setContext: () => undefined } as unknown as PinoLogger;

describe('las colas del SRI sobre la conexión compartida', () => {
  it('SRI-105: una declaración a medias se reintenta sin volver a declarar lo ya declarado', async () => {
    const { connection, declared } = fakeConnection('sri-authorise');
    const queues = new SriQueues(connection, enabled);

    await expect(queues.handles()).rejects.toThrow('ECONNRESET');
    expect(declared).toEqual(['sri-send']);

    const handles = await queues.handles();
    expect(declared).toEqual([
      'sri-send',
      'sri-authorise',
      'sri-deliver',
      'sri-sweep',
    ]);
    expect(Object.keys(handles.steps)).toEqual([
      'SEND',
      'AUTHORISE',
      'DELIVER',
    ]);
    expect(handles.sweep.name).toBe('sri-sweep');
  });

  it('SRI-040, SRI-057, SRI-106: encolar un paso lleva sólo el id, la clave como singleton y la espera del dominio', async () => {
    const { connection, sent } = fakeConnection();
    const queue = new PgBossVoucherQueue(new SriQueues(connection, enabled), silent); // prettier-ignore

    await queue.schedule('AUTHORISE', { id: VOUCHER, accessKey: '1'.repeat(49) }, 29.6); // prettier-ignore

    expect(sent).toEqual([
      {
        name: 'sri-authorise',
        data: { voucherId: VOUCHER },
        options: { singletonKey: '1'.repeat(49), startAfter: 30 },
      },
    ]);
  });
});
