import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Job, PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Env } from '../../config/env.schema';

import { PgBossConnection } from './pg-boss.connection';

/**
 * pg-boss without a database: a stub that keeps queues and records what is
 * sent and who works where. `start` can be told to fail.
 */
function stubBoss(existing: Record<string, string> = {}) {
  const queues = new Map(Object.entries(existing));
  const sent: { name: string; data: unknown }[] = [];
  const handlers = new Map<string, (jobs: Job<unknown>[]) => Promise<void>>();
  const boss = {
    on: () => undefined,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    getQueue: (name: string) =>
      Promise.resolve(
        queues.has(name) ? { name, policy: queues.get(name) } : null,
      ),
    createQueue: (name: string, options: { policy: string }) => {
      queues.set(name, options.policy);
      return Promise.resolve();
    },
    send: (name: string, data: unknown) => {
      sent.push({ name, data });
      return Promise.resolve('job-id');
    },
    work: (
      name: string,
      _options: unknown,
      handler: (jobs: Job<unknown>[]) => Promise<void>,
    ) => {
      handlers.set(name, handler);
      return Promise.resolve('worker-id');
    },
  } as unknown as PgBoss;
  return { boss, queues, sent, handlers };
}

const silent = {
  setContext: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

const configWith = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService<
    Env,
    true
  >;

/** A connection whose pg-boss is `boss`; `starts` decides each start. */
function connectionOver(
  boss: PgBoss,
  options: { nodeEnv?: string; starts?: (() => Promise<void>)[] } = {},
): PgBossConnection {
  const starts = options.starts ?? [];
  return new (class extends PgBossConnection {
    protected override create(): PgBoss {
      const next = starts.shift();
      if (next) (boss as unknown as { start: () => Promise<void> }).start = next; // prettier-ignore
      return boss;
    }
  })(configWith({ NODE_ENV: options.nodeEnv, DATABASE_URL: 'x' }), silent);
}

const draft = z.strictObject({ runId: z.uuid() });
const RUN = '01990000-0000-7000-8000-0000000000a1';

describe('la conexión pg-boss compartida', () => {
  it('SRI-105: cada módulo declara sus colas una vez; un nombre repetido falla, sea del mismo módulo o de otro', async () => {
    const { boss, queues } = stubBoss();
    const connection = connectionOver(boss);

    await connection.declareQueue('sri-send', draft, { policy: 'stately' });
    await connection.declareQueue('assistant-draft', draft, { policy: 'standard' }); // prettier-ignore
    expect([...queues.keys()]).toEqual(['sri-send', 'assistant-draft']);

    await expect(
      connection.declareQueue('sri-send', draft, { policy: 'stately' }),
    ).rejects.toThrow(/sri-send/);
  });

  it('SRI-105: dos declaraciones simultáneas del mismo nombre: exactamente una gana', async () => {
    const { boss } = stubBoss();
    const connection = connectionOver(boss);

    const outcomes = await Promise.allSettled([
      connection.declareQueue('assistant-draft', draft, { policy: 'standard' }), // prettier-ignore
      connection.declareQueue('assistant-draft', draft, { policy: 'standard' }), // prettier-ignore
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  it('SRI-105: un arranque fallido no deja la conexión inservible; el siguiente intento arranca y declara la misma cola', async () => {
    const { boss, queues } = stubBoss();
    const connection = connectionOver(boss, {
      starts: [
        () => Promise.reject(new Error('ECONNREFUSED')),
        () => Promise.resolve(),
      ],
    });

    await expect(
      connection.declareQueue('sri-send', draft, { policy: 'stately' }),
    ).rejects.toThrow('ECONNREFUSED');
    await connection.declareQueue('sri-send', draft, { policy: 'stately' });
    expect(queues.get('sri-send')).toBe('stately');
  });

  it('SRI-105: una cola que ya existe con otra política que la declarada falla al arrancar', async () => {
    const { boss } = stubBoss({ 'sri-send': 'standard' });
    const connection = connectionOver(boss);

    await expect(
      connection.declareQueue('sri-send', draft, { policy: 'stately' }),
    ).rejects.toThrow(/sri-send.*standard/);
    // Control positivo: the same queue, declared as it is.
    const other = connectionOver(stubBoss({ 'sri-send': 'stately' }).boss);
    await other.declareQueue('sri-send', draft, { policy: 'stately' });
  });

  it('SRI-106: el asa sólo encola en su cola y sólo lo que tiene su forma', async () => {
    const { boss, sent } = stubBoss();
    const queue = await connectionOver(boss).declareQueue(
      'assistant-draft',
      draft,
      { policy: 'standard' },
    );

    await queue.send({ runId: RUN });
    expect(sent).toEqual([{ name: 'assistant-draft', data: { runId: RUN } }]);

    for (const bad of [
      { runId: RUN, transcript: 'paciente refiere dolor' },
      { runId: 'no-es-un-uuid' },
    ]) {
      await expect(
        queue.send(bad as unknown as { runId: string }),
      ).rejects.toThrow();
    }
    expect(sent).toHaveLength(1);
  });

  it('SRI-106: un trabajo que no tiene la forma de su cola no llega a su trabajador; los demás del lote sí', async () => {
    const { boss, handlers } = stubBoss();
    const queue = await connectionOver(boss).declareQueue(
      'assistant-draft',
      draft,
      { policy: 'standard' },
    );
    const reached: unknown[] = [];
    await queue.work({ batchSize: 10 }, (jobs) => {
      reached.push(...jobs.map((job) => job.data));
      return Promise.resolve();
    });

    await handlers.get('assistant-draft')!([
      { id: 'a', data: { runId: RUN } },
      { id: 'b', data: { transcript: 'paciente refiere dolor' } },
    ] as Job<unknown>[]);
    expect(reached).toEqual([{ runId: RUN }]);
  });

  it('SRI-107: desde la aplicación con NODE_ENV=test la conexión no arranca; con la configuración de una prueba, sí', async () => {
    const { boss } = stubBoss();
    await expect(
      connectionOver(boss, { nodeEnv: 'test' }).declareQueue('sri-send', draft, { policy: 'stately' }), // prettier-ignore
    ).rejects.toThrow(/NODE_ENV=test/);

    await connectionOver(stubBoss().boss).declareQueue('sri-send', draft, {
      policy: 'stately',
    });
  });

  it('SRI-105: apagar mientras arranca para la instancia que estaba arrancando, y después no vuelve a arrancar', async () => {
    const { boss } = stubBoss();
    let stopped = 0;
    (boss as unknown as { stop: () => Promise<void> }).stop = () => {
      stopped += 1;
      return Promise.resolve();
    };
    let finishStart!: () => void;
    const connection = connectionOver(boss, {
      starts: [() => new Promise<void>((resolve) => (finishStart = resolve))],
    });

    const declaring = connection.declareQueue('sri-send', draft, {
      policy: 'stately',
    });
    const shutdown = connection.onApplicationShutdown();
    finishStart();
    await shutdown;
    await declaring.catch(() => undefined);

    expect(stopped).toBe(1);
    await expect(
      connection.declareQueue('assistant-draft', draft, { policy: 'standard' }), // prettier-ignore
    ).rejects.toThrow(/stopped/);
  });
});
