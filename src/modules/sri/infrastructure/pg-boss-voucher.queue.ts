import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';

import type { Env } from '../../../shared/config/env.schema';
import { PgBossConnection } from '../../../shared/infrastructure/queue/pg-boss.connection';
import { VoucherDispatchService } from '../application/voucher-dispatch.service';
import type { VoucherQueue } from '../domain/electronic-voucher.repository';
import type { QueueStep } from '../domain/voucher-lifecycle';

/**
 * SRI-040, SRI-057. The persistent queue: pg-boss, on the connection every
 * module shares (`shared/infrastructure/queue`, SRI-105).
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

/**
 * SRI-105. The SRI's queues on the shared connection, declared once for the
 * sender and the worker, and the SRI's own switch: `SRI_QUEUE_ENABLED=false`
 * stops these queues and no other module's.
 */
@Injectable()
export class SriQueues {
  private ready: Promise<PgBoss> | null = null;

  constructor(
    private readonly connection: PgBossConnection,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('SRI_QUEUE_ENABLED', { infer: true });
  }

  boss(): Promise<PgBoss> {
    this.ready ??= (async () => {
      let boss: PgBoss | null = null;
      for (const name of [...Object.values(QUEUE_NAMES), SWEEP_QUEUE]) {
        boss = await this.connection.declareQueue(name, {
          policy: name === SWEEP_QUEUE ? 'exclusive' : 'stately',
          retryLimit: 3,
          retryDelay: 30,
          retryBackoff: true,
        });
      }
      return boss!;
    })();
    return this.ready;
  }
}

@Injectable()
export class PgBossVoucherQueue implements VoucherQueue {
  constructor(
    private readonly queues: SriQueues,
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
    if (!this.queues.enabled) return;
    const boss = await this.queues.boss();
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
    private readonly queues: SriQueues,
    private readonly dispatch: VoucherDispatchService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SriQueueWorker.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.enabled) return;
    await this.start();
  }

  async start(): Promise<void> {
    const boss = await this.queues.boss();
    for (const [step, name] of Object.entries(QUEUE_NAMES) as [
      QueueStep,
      string,
    ][]) {
      // Ten per fetch, polled every second: after an SRI outage the backlog
      // drains in batches instead of one job every two seconds (pg-boss's
      // default), and an idle queue costs one cheap query a second.
      await boss.work<StepJob>(name, WORK_OPTIONS, async (jobs) => {
        for (const job of jobs) {
          // One job that throws must not fail the other nine of its batch.
          // Its voucher keeps its status, so the sweep queues it again
          // (SRI-056); nothing is lost by completing this job.
          try {
            await this.dispatch.run(step, job.data.voucherId);
          } catch (error) {
            this.logger.error(
              {
                err: error,
                voucher_id: job.data.voucherId,
                error_code: 'SRI_JOB_FAILED',
              },
              'a voucher job failed; the sweep will queue it again',
            );
          }
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
