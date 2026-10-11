import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env.schema';

import { PgBossConnection } from './pg-boss.connection';

/** The connection without a database: pg-boss is a stub that keeps queues. */
function offline(): { connection: PgBossConnection; created: string[] } {
  const created: string[] = [];
  const boss = {
    getQueue: (name: string) =>
      Promise.resolve(created.includes(name) ? { name } : null),
    createQueue: (name: string) => {
      created.push(name);
      return Promise.resolve();
    },
  } as unknown as PgBoss;
  const connection = new (class extends PgBossConnection {
    override instance(): Promise<PgBoss> {
      return Promise.resolve(boss);
    }
  })(
    {} as ConfigService<Env, true>,
    { setContext: () => undefined } as unknown as PinoLogger,
  );
  return { connection, created };
}

describe('la conexión pg-boss compartida', () => {
  it('SRI-105: cada módulo declara sus colas una vez; un nombre repetido falla, sea del mismo módulo o de otro', async () => {
    const { connection, created } = offline();

    await connection.declareQueue('sri-send', { policy: 'stately' });
    await connection.declareQueue('assistant-draft', { policy: 'standard' });
    expect(created).toEqual(['sri-send', 'assistant-draft']);

    await expect(
      connection.declareQueue('sri-send', { policy: 'standard' }),
    ).rejects.toThrow(/sri-send/);
    expect(created).toEqual(['sri-send', 'assistant-draft']);
  });
});
