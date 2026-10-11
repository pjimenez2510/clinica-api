import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { VoucherDispatchService } from '../../src/modules/sri/application/voucher-dispatch.service';
import type { QueueStep } from '../../src/modules/sri/domain/voucher-lifecycle';
import {
  PgBossVoucherQueue,
  QUEUE_NAMES,
  SriQueues,
  SriQueueWorker,
} from '../../src/modules/sri/infrastructure/pg-boss-voucher.queue';
import type { Env } from '../../src/shared/config/env.schema';
import type { LiveEvent } from '../../src/shared/events/live-event';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';
import { PgBossConnection } from '../../src/shared/infrastructure/queue/pg-boss.connection';

import { useDatabase } from './setup/database';
import { until } from './setup/live-stream';

/**
 * SRI-105 against a real PostgreSQL and a real pg-boss: the SRI and a second
 * module —here a stand-in for the assistant, which arrives later— queue on the
 * one shared connection, and each job reaches only its own worker. The second
 * module's worker ends the way the assistant's will: by telling whoever asked
 * that the draft is ready (AU-060).
 *
 * The SRI's handler is a recorder: what it does with a voucher is
 * `sri-voucher-flow.spec.ts`; here only WHICH jobs reach it matters.
 */
const db = useDatabase();

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

const OTHER_QUEUE = 'assistant-draft-test';
const SITE = '01990000-0000-7000-8000-00000000000a';
const DOCTOR = '01990000-0000-7000-8000-0000000000d1';

let connection: PgBossConnection;
let configFor: (sriQueueEnabled: boolean) => ConfigService<Env, true>;

beforeAll(async () => {
  // `pgboss` is not truncated between tests: it is the library's schema, and
  // the files before this one (`sri-voucher-flow.spec.ts`) leave retries
  // waiting in it. A worker started here would take them, so the exact
  // «only these jobs» below starts from an empty queue.
  await db().$executeRawUnsafe(
    `DO $$ BEGIN IF to_regclass('pgboss.job') IS NOT NULL THEN DELETE FROM pgboss.job; END IF; END $$`,
  );
  configFor = (sriQueueEnabled) => {
    const values: Record<string, unknown> = {
      DATABASE_URL: inject('databaseUrl'),
      SRI_QUEUE_ENABLED: sriQueueEnabled,
    };
    return { get: (key: string) => values[key] } as unknown as ConfigService<
      Env,
      true
    >;
  };
  connection = new PgBossConnection(configFor(true), silentLogger);
});

afterAll(async () => {
  await connection.onApplicationShutdown();
});

/** What reached the SRI's worker, by step. */
function recordingDispatch(): {
  dispatch: VoucherDispatchService;
  ran: { step: QueueStep; voucherId: string }[];
} {
  const ran: { step: QueueStep; voucherId: string }[] = [];
  const dispatch = {
    run: (step: QueueStep, voucherId: string) => {
      ran.push({ step, voucherId });
      return Promise.resolve();
    },
    sweep: () => Promise.resolve(),
  } as unknown as VoucherDispatchService;
  return { dispatch, ran };
}

const jobsNamed = async (name: string): Promise<{ data: unknown }[]> =>
  db().$queryRawUnsafe(`SELECT data FROM pgboss.job WHERE name = $1`, name);

describe('la cola de trabajos compartida', () => {
  it('SRI-105: un trabajo de otro módulo y un comprobante, en la misma conexión, los atiende cada uno sólo su trabajador; y el del otro módulo avisa a quien lo pidió', async () => {
    const sriQueues = new SriQueues(connection, configFor(true));
    const { dispatch, ran } = recordingDispatch();
    await new SriQueueWorker(sriQueues, dispatch, silentLogger).start();

    // The other module: its own queue, its own worker, its own notice.
    const bus = new InProcessLiveEventBus();
    const heard: LiveEvent[] = [];
    bus.subscribe((event) => heard.push(event));
    const drafts: unknown[] = [];
    const boss = await connection.declareQueue(OTHER_QUEUE, {
      policy: 'standard',
    });
    await boss.work<{ draftId: string }>(
      OTHER_QUEUE,
      { pollingIntervalSeconds: 0.5 },
      (jobs) => {
        for (const job of jobs) {
          drafts.push(job.data);
          bus.publish({ kind: 'assistant-draft', siteId: SITE, userIds: [DOCTOR] }); // prettier-ignore
        }
        return Promise.resolve();
      },
    );

    const voucherId = '01990000-0000-7000-8000-0000000000f1';
    await new PgBossVoucherQueue(sriQueues, silentLogger).schedule(
      'SEND',
      { id: voucherId, accessKey: '1'.repeat(49) },
      0,
    );
    await boss.send(OTHER_QUEUE, { draftId: 'borrador-1' });

    await until(() => ran.length === 1 && drafts.length === 1, 15_000);
    expect(ran).toEqual([{ step: 'SEND', voucherId }]);
    expect(drafts).toEqual([{ draftId: 'borrador-1' }]);
    expect(heard).toEqual([
      { kind: 'assistant-draft', siteId: SITE, userIds: [DOCTOR] },
    ]);
    // Each job is in its own queue, and nowhere else.
    expect(await jobsNamed(QUEUE_NAMES.SEND)).toEqual([{ data: { voucherId } }]); // prettier-ignore
    expect(await jobsNamed(OTHER_QUEUE)).toEqual([{ data: { draftId: 'borrador-1' } }]); // prettier-ignore

    for (const name of [...Object.values(QUEUE_NAMES), OTHER_QUEUE]) {
      await boss.offWork(name);
    }
  }, 30_000);

  it('SRI-105: un módulo que declara una cola del SRI falla, y no le quita sus trabajos', async () => {
    // The SRI's queues are already declared on this connection by the case
    // above; the positive control is that case itself, same connection.
    await expect(
      connection.declareQueue(QUEUE_NAMES.SEND, { policy: 'standard' }),
    ).rejects.toThrow(QUEUE_NAMES.SEND);
  });

  it('SRI-105: con `SRI_QUEUE_ENABLED=false` el SRI no encola, y el otro módulo sigue trabajando en la misma conexión', async () => {
    const off = new PgBossConnection(configFor(false), silentLogger);
    try {
      const sriQueues = new SriQueues(off, configFor(false));
      const { dispatch } = recordingDispatch();
      const worker = new SriQueueWorker(sriQueues, dispatch, silentLogger);
      await worker.onApplicationBootstrap();
      const before = (await jobsNamed(QUEUE_NAMES.AUTHORISE)).length;
      await new PgBossVoucherQueue(sriQueues, silentLogger).schedule(
        'AUTHORISE',
        { id: '01990000-0000-7000-8000-0000000000f2', accessKey: '2'.repeat(49) }, // prettier-ignore
        0,
      );
      expect(await jobsNamed(QUEUE_NAMES.AUTHORISE)).toHaveLength(before);

      const otherQueue = `${OTHER_QUEUE}-off`;
      const boss = await off.declareQueue(otherQueue, { policy: 'standard' });
      const done: unknown[] = [];
      await boss.work<{ n: number }>(
        otherQueue,
        { pollingIntervalSeconds: 0.5 },
        (jobs) => {
          done.push(...jobs.map((job) => job.data));
          return Promise.resolve();
        },
      );
      await boss.send(otherQueue, { n: 1 });
      await until(() => done.length === 1, 15_000);
      expect(done).toEqual([{ n: 1 }]);
    } finally {
      await off.onApplicationShutdown();
    }
  }, 30_000);
});
