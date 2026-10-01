import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { PgBoss } from 'pg-boss';

import type { Env } from '../../../shared/config/env.schema';
import { VoucherDispatchService } from '../application/voucher-dispatch.service';
import type { VoucherQueue } from '../domain/electronic-voucher.repository';
import type { QueueStep } from '../domain/voucher-lifecycle';

/**
 * SRI-040, SRI-057. The persistent queue: pg-boss, in the clinic's own
 * PostgreSQL (ADR-004), in schema `pgboss`, which pg-boss creates and migrates
 * itself — it is the library's state, not this system's model, and it is
 * deliberately outside `prisma/migrations`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE QUEUE PER STEP, POLICY `stately`, THE ACCESS KEY AS `singletonKey`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `stately` admits ONE job per key per state: at most one queued and one
 * active. That is SRI-057 made structural — the sweep re-queueing a voucher
 * whose job is already queued is a no-op — and it still lets a running job
 * queue its own retry (the retry is `created`, the runner is `active`).
 *
 * The retries are NOT pg-boss's: each handler records the attempt and queues
 * the next one with the delay the domain chose (`retryDelaySeconds`), so the
 * monitor can say when the next attempt is (SRI-052). pg-boss's own retry
 * only covers a crash in the middle of a handler.
 */
export const QUEUE_NAMES: Record<QueueStep, string> = {
  SEND: 'sri-send',
  AUTHORISE: 'sri-authorise',
  DELIVER: 'sri-deliver',
};
const SWEEP_QUEUE = 'sri-sweep';
const WORK_OPTIONS = { batchSize: 10, pollingIntervalSeconds: 1 } as const;

interface StepJob {
  voucherId: string;
}

/** The pg-boss instance, started once and shared by the queue and the worker. */
@Injectable()
export class PgBossConnection implements OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PgBossConnection.name);
  }

  get enabled(): boolean {
    return this.config.get('SRI_QUEUE_ENABLED', { infer: true });
  }

  async instance(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    this.starting ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.config.get('DATABASE_URL', { infer: true }),
        schema: 'pgboss',
      });
      // pg-boss emits its own operational errors (a lost connection, a failed
      // maintenance pass); unheard, they would crash the process.
      boss.on('error', (error) =>
        this.logger.error(
          { err: error, error_code: 'SRI_QUEUE_ERROR' },
          'the voucher queue reported an error',
        ),
      );
      await boss.start();
      for (const name of [...Object.values(QUEUE_NAMES), SWEEP_QUEUE]) {
        if (!(await boss.getQueue(name))) {
          await boss.createQueue(name, {
            policy: name === SWEEP_QUEUE ? 'exclusive' : 'stately',
            retryLimit: 3,
            retryDelay: 30,
            retryBackoff: true,
          });
        }
      }
      this.boss = boss;
      return boss;
    })();
    return this.starting;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
    this.starting = null;
  }
}

@Injectable()
export class PgBossVoucherQueue implements VoucherQueue {
  constructor(
    private readonly connection: PgBossConnection,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PgBossVoucherQueue.name);
  }

  async schedule(
    step: QueueStep,
    voucher: { id: string; accessKey: string },
    delaySeconds: number,
  ): Promise<void> {
    // Without a running queue the sweep is what picks the voucher up.
    if (!this.connection.enabled) return;
    const boss = await this.connection.instance();
    await boss.send(
      QUEUE_NAMES[step],
      { voucherId: voucher.id } satisfies StepJob,
      {
        singletonKey: voucher.accessKey,
        startAfter: Math.max(0, Math.round(delaySeconds)),
      },
    );
  }
}

/**
 * SRI-040, SRI-056. The workers and the sweep, in the API process. One
 * process is what the clinic runs; a separate worker process is a later
 * decision that changes nothing above this file.
 */
@Injectable()
export class SriQueueWorker implements OnApplicationBootstrap {
  constructor(
    private readonly connection: PgBossConnection,
    private readonly dispatch: VoucherDispatchService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SriQueueWorker.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection.enabled) return;
    await this.start();
  }

  async start(): Promise<void> {
    const boss = await this.connection.instance();
    for (const [step, name] of Object.entries(QUEUE_NAMES) as [
      QueueStep,
      string,
    ][]) {
      // Ten per fetch, polled every second: after an SRI outage the backlog
      // drains in batches instead of one job every two seconds (pg-boss's
      // default), and an idle queue costs one cheap query a second.
      await boss.work<StepJob>(name, WORK_OPTIONS, async (jobs) => {
        for (const job of jobs) {
          await this.dispatch.run(step, job.data.voucherId);
        }
      });
    }
    await boss.work(SWEEP_QUEUE, async () => {
      await this.dispatch.sweep();
    });
    // SRI-056. Every minute: the safety net under «the notice swallows».
    await boss.schedule(SWEEP_QUEUE, '* * * * *');
    this.logger.info({}, 'SRI voucher queue started');
  }
}
