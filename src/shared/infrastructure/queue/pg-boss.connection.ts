import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { PgBoss, type Queue } from 'pg-boss';

import type { Env } from '../../config/env.schema';

/**
 * SRI-040, SRI-105. The one pg-boss of the process, shared by every module
 * that queues work: the SRI's vouchers, and the assistant's drafts after it
 * (`PLAN-ASISTENTE-IA.md` §4). In the clinic's own PostgreSQL (ADR-004), in
 * schema `pgboss`, which pg-boss creates and migrates itself — it is the
 * library's state, not this system's model, and it is deliberately outside
 * `prisma/migrations`.
 *
 * LAZY, AND WITHOUT A SWITCH OF ITS OWN. It starts the first time a module
 * declares a queue; whether a module queues at all is that module's switch
 * (`SRI_QUEUE_ENABLED` for the SRI), so turning one module's queue off leaves
 * the others running.
 *
 * EACH QUEUE IS DECLARED ONCE. Two modules that happened to pick the same
 * name would take each other's jobs, and the handler would receive a payload
 * it does not know. The second declaration fails, at start-up, instead.
 */
@Injectable()
export class PgBossConnection implements OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;
  private readonly declared = new Set<string>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PgBossConnection.name);
  }

  async declareQueue(
    name: string,
    options: Omit<Queue, 'name'>,
  ): Promise<PgBoss> {
    if (this.declared.has(name)) {
      throw new Error(`the job queue "${name}" is declared twice`);
    }
    this.declared.add(name);
    const boss = await this.instance();
    if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
    return boss;
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
          { err: error, error_code: 'JOB_QUEUE_ERROR' },
          'the job queue reported an error',
        ),
      );
      await boss.start();
      this.boss = boss;
      return boss;
    })();
    return this.starting;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
    this.starting = null;
    this.declared.clear();
  }
}
