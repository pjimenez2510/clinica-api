import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import {
  type Job,
  PgBoss,
  type Queue,
  type SendOptions,
  type WorkOptions,
} from 'pg-boss';
import type { z } from 'zod';

import type { Env } from '../../config/env.schema';

/**
 * SRI-106. One queue, as the module that declared it sees it: everything is
 * bound to its name, and every job must have its declared shape. A module
 * holds the handles of its own queues and nothing else of pg-boss, so it
 * cannot send to, work on or schedule another module's queue.
 */
export interface JobQueue<T> {
  readonly name: string;
  send(data: T, options?: SendOptions): Promise<void>;
  work(
    options: WorkOptions,
    handler: (jobs: Job<T>[]) => Promise<void>,
  ): Promise<void>;
  schedule(cron: string): Promise<void>;
  offWork(): Promise<void>;
}

/**
 * SRI-040, SRI-105 to SRI-107. The one pg-boss of the process, shared by every
 * module that queues work: the SRI's vouchers, and the assistant's drafts
 * after it (`PLAN-ASISTENTE-IA.md` §4). In the clinic's own PostgreSQL
 * (ADR-004), in schema `pgboss`, which pg-boss creates and migrates itself —
 * it is the library's state, not this system's model, and it is deliberately
 * outside `prisma/migrations`.
 *
 * LAZY, AND WITHOUT A SWITCH OF ITS OWN. It starts the first time a module
 * declares a queue; whether a module queues at all is that module's switch
 * (`SRI_QUEUE_ENABLED` for the SRI), so turning one module's queue off leaves
 * the others running. The one exception is the test suite (SRI-107): booted
 * by the application with `NODE_ENV=test` it never starts, so no module that
 * forgot its switch can reach the developer's database.
 *
 * EACH QUEUE IS DECLARED ONCE. Two modules that happened to pick the same
 * name would take each other's jobs, and the handler would receive a payload
 * it does not know. The second declaration fails, at start-up, instead.
 *
 * WHAT IS QUEUED IS AN IDENTIFIER (SRI-106). `pgboss.job` keeps each job's
 * data in clear, outside the access log: the declared shape is what keeps
 * clinical content out of it.
 */
@Injectable()
export class PgBossConnection implements OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;
  private stopped = false;
  private readonly declared = new Set<string>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PgBossConnection.name);
  }

  async declareQueue<T>(
    name: string,
    shape: z.ZodType<T>,
    options: Omit<Queue, 'name'>,
  ): Promise<JobQueue<T>> {
    // Reserved BEFORE the first `await`: two simultaneous declarations of one
    // name cannot both pass.
    if (this.declared.has(name)) {
      throw new Error(`the job queue "${name}" is declared twice`);
    }
    this.declared.add(name);
    try {
      const boss = await this.instance();
      // A shutdown that arrived while pg-boss was starting: no handle on a
      // stopped instance.
      if (this.stopped) throw new Error('the job queue is stopped');
      const existing = await boss.getQueue(name);
      if (!existing) {
        await boss.createQueue(name, options);
      } else if (options.policy && existing.policy !== options.policy) {
        throw new Error(
          `the job queue "${name}" exists with policy ${existing.policy}, not ${options.policy}`,
        );
      }
      return this.handle(boss, name, shape);
    } catch (error) {
      // A failed declaration — the database was down — is not a declaration:
      // the next attempt must not be told «declared twice».
      this.declared.delete(name);
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    // A shutdown that arrives while pg-boss is starting stops it too.
    const boss = this.boss ?? (await this.starting?.catch(() => null)) ?? null;
    await boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
    this.starting = null;
  }

  /** The library itself; the tests replace it with a stub. */
  protected create(): PgBoss {
    return new PgBoss({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      schema: 'pgboss',
    });
  }

  private instance(): Promise<PgBoss> {
    if (this.stopped) {
      return Promise.reject(new Error('the job queue is stopped'));
    }
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') {
      return Promise.reject(
        new Error(
          'the job queue does not start inside the application with NODE_ENV=test; a test that needs it builds it against its container',
        ),
      );
    }
    if (this.boss) return Promise.resolve(this.boss);
    this.starting ??= (async () => {
      let boss: PgBoss | null = null;
      try {
        boss = this.create();
        // pg-boss emits its own operational errors (a lost connection, a
        // failed maintenance pass); unheard, they would crash the process.
        boss.on('error', (error) =>
          this.logger.error(
            { err: error, error_code: 'JOB_QUEUE_ERROR' },
            'the job queue reported an error',
          ),
        );
        await boss.start();
      } catch (error) {
        // Not cached: the next declaration tries again. And what started
        // halfway —a pool, its timers— is stopped, as pg-boss asks, so each
        // retry does not leave one more behind.
        this.starting = null;
        await boss?.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
      this.boss = boss;
      return boss;
    })();
    return this.starting;
  }

  private handle<T>(
    boss: PgBoss,
    name: string,
    shape: z.ZodType<T>,
  ): JobQueue<T> {
    return {
      name,
      send: async (data, options) => {
        await boss.send(name, shape.parse(data) as object, options ?? {});
      },
      work: async (options, handler) => {
        await boss.work<unknown>(name, options, async (jobs) => {
          const valid: Job<T>[] = [];
          for (const job of jobs) {
            const parsed = shape.safeParse(job.data);
            if (parsed.success) {
              valid.push({ ...job, data: parsed.data });
            } else {
              // Completed and dropped: retrying cannot give it another shape.
              // The data is not logged: it is what failed to be an id. `id`
              // is the job's, `type` the queue's: keys `log-privacy` keeps.
              this.logger.error(
                { id: job.id, type: name, error_code: 'JOB_PAYLOAD_INVALID' },
                'a job without the shape of its queue was dropped',
              );
            }
          }
          if (valid.length > 0) await handler(valid);
        });
      },
      schedule: async (cron) => {
        await boss.schedule(name, cron);
      },
      offWork: async () => {
        await boss.offWork(name);
      },
    };
  }
}
