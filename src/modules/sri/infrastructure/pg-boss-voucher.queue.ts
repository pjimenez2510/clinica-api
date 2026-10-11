import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import type { Env } from '../../../shared/config/env.schema';
import {
  type JobQueue,
  PgBossConnection,
} from '../../../shared/infrastructure/queue/pg-boss.connection';
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

/** SRI-106. A step's job carries the voucher's id and nothing else. */
const stepJob = z.strictObject({ voucherId: z.uuid() });
type StepJob = z.infer<typeof stepJob>;
/** The sweep's jobs come from its schedule and carry nothing. */
const sweepJob = z.strictObject({}).nullish();

interface SriQueueHandles {
  steps: Record<QueueStep, JobQueue<StepJob>>;
  sweep: JobQueue<z.infer<typeof sweepJob>>;
}

/**
 * SRI-105, SRI-106. The SRI's queues on the shared connection, declared once
 * for the sender and the worker, and the SRI's own switch:
 * `SRI_QUEUE_ENABLED=false` stops these queues and no other module's.
 *
 * A declaration that fails —the database was down at start-up— is tried
 * again on the next use; the queues already declared are kept, since the
 * connection refuses a name twice.
 */
@Injectable()
export class SriQueues {
  private readonly steps: Partial<Record<QueueStep, JobQueue<StepJob>>> = {};
  private sweep: SriQueueHandles['sweep'] | null = null;
  private ready: Promise<SriQueueHandles> | null = null;

  constructor(
    private readonly connection: PgBossConnection,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('SRI_QUEUE_ENABLED', { infer: true });
  }

  handles(): Promise<SriQueueHandles> {
    this.ready ??= this.declare().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async declare(): Promise<SriQueueHandles> {
    const options = { retryLimit: 3, retryDelay: 30, retryBackoff: true };
    for (const [step, name] of Object.entries(QUEUE_NAMES) as [
      QueueStep,
      string,
    ][]) {
      this.steps[step] ??= await this.connection.declareQueue(name, stepJob, {
        ...options,
        policy: 'stately',
      });
    }
    this.sweep ??= await this.connection.declareQueue(SWEEP_QUEUE, sweepJob, {
      ...options,
      policy: 'exclusive',
    });
    return {
      steps: this.steps as Record<QueueStep, JobQueue<StepJob>>,
      sweep: this.sweep,
    };
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
    const { steps } = await this.queues.handles();
    await steps[step].send(
      { voucherId: voucher.id },
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
    const { steps, sweep } = await this.queues.handles();
    for (const [step, queue] of Object.entries(steps) as [
      QueueStep,
      JobQueue<StepJob>,
    ][]) {
      // Ten per fetch, polled every second: after an SRI outage the backlog
      // drains in batches instead of one job every two seconds (pg-boss's
      // default), and an idle queue costs one cheap query a second.
      await queue.work(WORK_OPTIONS, async (jobs) => {
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
    await sweep.work({}, async () => {
      await this.dispatch.sweep();
    });
    // SRI-056. Every minute: the safety net under «the notice swallows».
    await sweep.schedule('* * * * *');
    this.logger.info({}, 'SRI voucher queue started');
  }
}
