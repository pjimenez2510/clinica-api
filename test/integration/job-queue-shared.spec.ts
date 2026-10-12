import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';

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
import {
  type JobQueue,
  PgBossConnection,
} from '../../src/shared/infrastructure/queue/pg-boss.connection';

import { useDatabase } from './setup/database';
import { until } from './setup/live-stream';

/**
 * SRI-105 and SRI-106 against a real PostgreSQL and a real pg-boss: the SRI
 * and a second module —here a stand-in for the assistant, which arrives
 * later— queue on the one shared connection, and each job reaches only its
 * own worker. The second module's worker ends the way the assistant's will:
 * by telling whoever asked that the draft is ready (AU-060).
 *
 * The SRI's handler is a recorder: what it does with a voucher is
 * `sri-voucher-flow.spec.ts`; here only WHICH jobs reach it matters.
 *
 * Each case has its own connection, stopped after it, and starts from an
 * empty `pgboss.job`: pg-boss's schema is not truncated between tests, and
 * the files before this one (`sri-voucher-flow.spec.ts`) leave retries
 * waiting in it that a worker started here would take.
 */
const db = useDatabase();

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

const draftJob = z.strictObject({ runId: z.uuid() });
const OTHER_QUEUE = 'assistant-draft-test';
const SITE = '01990000-0000-7000-8000-00000000000a';
const DOCTOR = '01990000-0000-7000-8000-0000000000d1';
const RUN = '01990000-0000-7000-8000-0000000000a1';
const VOUCHER = '01990000-0000-7000-8000-0000000000f1';

/** The configuration a test gives the queue: its container, no `NODE_ENV`. */
const configFor = (sriQueueEnabled: boolean): ConfigService<Env, true> => {
  const values: Record<string, unknown> = {
    DATABASE_URL: inject('databaseUrl'),
    SRI_QUEUE_ENABLED: sriQueueEnabled,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    Env,
    true
  >;
};

let connection: PgBossConnection;

beforeEach(async () => {
  await db().$executeRawUnsafe(
    `DO $$ BEGIN IF to_regclass('pgboss.job') IS NOT NULL THEN DELETE FROM pgboss.job; END IF; END $$`,
  );
  connection = new PgBossConnection(configFor(true), silentLogger);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await connection.onApplicationShutdown();
});

/** What reached the SRI's worker, by step. */
function recordingDispatch(): {
  dispatch: VoucherDispatchService;
  ran: { step: QueueStep; voucherId: string }[];
  sweeps: { count: number };
} {
  const ran: { step: QueueStep; voucherId: string }[] = [];
  const sweeps = { count: 0 };
  const dispatch = {
    run: (step: QueueStep, voucherId: string) => {
      ran.push({ step, voucherId });
      return Promise.resolve();
    },
    sweep: () => {
      sweeps.count += 1;
      return Promise.resolve();
    },
  } as unknown as VoucherDispatchService;
  return { dispatch, ran, sweeps };
}

const jobsNamed = (name: string): Promise<{ data: unknown; state: string }[]> =>
  db().$queryRawUnsafe(
    `SELECT data, state::text AS state FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
    name,
  );

/** The other module: its queue, a worker that records and announces. */
async function otherModule(on: PgBossConnection) {
  const queue: JobQueue<{ runId: string }> = await on.declareQueue(
    OTHER_QUEUE,
    draftJob,
    { policy: 'standard' },
  );
  const bus = new InProcessLiveEventBus();
  const heard: LiveEvent[] = [];
  bus.subscribe((event) => heard.push(event));
  const drafts: unknown[] = [];
  await queue.work({ pollingIntervalSeconds: 0.5 }, (jobs) => {
    for (const job of jobs) {
      drafts.push(job.data);
      bus.publish({ kind: 'assistant-draft', siteId: SITE, userIds: [DOCTOR] }); // prettier-ignore
    }
    return Promise.resolve();
  });
  return { queue, drafts, heard };
}

describe('la cola de trabajos compartida', () => {
  it('SRI-105: un trabajo de otro módulo y un comprobante, en la misma conexión, los atiende cada uno sólo su trabajador; y el del otro módulo avisa a quien lo pidió', async () => {
    const sriQueues = new SriQueues(connection, configFor(true));
    const { dispatch, ran, sweeps } = recordingDispatch();
    await new SriQueueWorker(sriQueues, dispatch, silentLogger).start();
    const other = await otherModule(connection);
    // SRI-056 through SRI-106: a sweep job as its schedule leaves it, with no
    // data, still has the sweep's shape and reaches the sweep.
    await db().$executeRawUnsafe(
      `INSERT INTO pgboss.job (name, data) VALUES ('sri-sweep', NULL)`,
    );
    // `>= 1`: the minute's cron may add its own.
    await until(() => sweeps.count >= 1, 15_000);

    await new PgBossVoucherQueue(sriQueues, silentLogger).schedule(
      'SEND',
      { id: VOUCHER, accessKey: '1'.repeat(49) },
      0,
    );
    await other.queue.send({ runId: RUN });

    await until(() => ran.length === 1 && other.drafts.length === 1, 15_000);
    expect(ran).toEqual([{ step: 'SEND', voucherId: VOUCHER }]);
    expect(other.drafts).toEqual([{ runId: RUN }]);
    expect(other.heard).toEqual([
      { kind: 'assistant-draft', siteId: SITE, userIds: [DOCTOR] },
    ]);
    // Each job is in its own queue, and nowhere else.
    expect((await jobsNamed(QUEUE_NAMES.SEND)).map((job) => job.data)).toEqual([{ voucherId: VOUCHER }]); // prettier-ignore
    expect((await jobsNamed(OTHER_QUEUE)).map((job) => job.data)).toEqual([{ runId: RUN }]); // prettier-ignore
  }, 30_000);

  it('SRI-105: un módulo que declara una cola del SRI falla, y el comprobante encolado sigue en la del SRI esperando a su trabajador', async () => {
    const sriQueues = new SriQueues(connection, configFor(true));
    await new PgBossVoucherQueue(sriQueues, silentLogger).schedule(
      'SEND',
      { id: VOUCHER, accessKey: '1'.repeat(49) },
      0,
    );
    // Control positivo: the other module declares its own queue on the same
    // connection.
    await otherModule(connection);

    await expect(
      connection.declareQueue(QUEUE_NAMES.SEND, draftJob, {
        policy: 'stately',
      }),
    ).rejects.toThrow(QUEUE_NAMES.SEND);
    expect(await jobsNamed(QUEUE_NAMES.SEND)).toEqual([
      { data: { voucherId: VOUCHER }, state: 'created' },
    ]);
  }, 30_000);

  it('SRI-106: lo que no tiene la forma de su cola no se encola, y lo que ya estaba no llega al trabajador', async () => {
    const other = await otherModule(connection);

    await expect(
      other.queue.send({
        runId: RUN,
        transcript: 'paciente refiere dolor',
      } as unknown as { runId: string }),
    ).rejects.toThrow();
    expect(await jobsNamed(OTHER_QUEUE)).toEqual([]);

    // A job written by other means —an older version, a hand in the
    // database— with clinical text in it: dropped, never handled. The valid
    // one sent after it is the positive control on the same worker.
    await db().$executeRawUnsafe(
      `INSERT INTO pgboss.job (name, data) VALUES ($1, $2::jsonb)`,
      OTHER_QUEUE,
      JSON.stringify({ transcript: 'paciente refiere dolor' }),
    );
    await other.queue.send({ runId: RUN });
    await until(() => other.drafts.length === 1, 15_000);
    let states: string[] = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      states = (await jobsNamed(OTHER_QUEUE)).map((job) => job.state);
      if (states.every((state) => state === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(states).toEqual(['completed', 'completed']);
    expect(other.drafts).toEqual([{ runId: RUN }]);
  }, 30_000);

  it('SRI-105: con `SRI_QUEUE_ENABLED=false` el SRI ni encola ni arranca su trabajador, y el otro módulo sigue trabajando en la misma conexión', async () => {
    const sriQueues = new SriQueues(connection, configFor(false));
    const declares = vi.spyOn(sriQueues, 'handles');
    const { dispatch } = recordingDispatch();
    await new SriQueueWorker(sriQueues, dispatch, silentLogger).onApplicationBootstrap(); // prettier-ignore
    await new PgBossVoucherQueue(sriQueues, silentLogger).schedule(
      'AUTHORISE',
      { id: VOUCHER, accessKey: '2'.repeat(49) },
      0,
    );
    expect(declares).not.toHaveBeenCalled();
    expect(await jobsNamed(QUEUE_NAMES.AUTHORISE)).toEqual([]);

    const other = await otherModule(connection);
    await other.queue.send({ runId: RUN });
    await until(() => other.drafts.length === 1, 15_000);
    // And the SRI's names are free on this connection: it declared nothing.
    await connection.declareQueue(QUEUE_NAMES.AUTHORISE, z.unknown(), {
      policy: 'stately',
    });
  }, 30_000);
});
