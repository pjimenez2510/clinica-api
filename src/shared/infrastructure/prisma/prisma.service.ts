import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { Env } from '../../config/env.schema';

/**
 * Cliente de Prisma con adaptador de driver.
 *
 * Prisma 7 removed the URL from the schema: the client receives an adapter
 * built here. The real benefit is that the connection pool is ours to control
 * rather than Prisma's — which matters because pg-boss shares the same database
 * and the quota has to be split between them.
 *
 * ⚠️ TODO: that control is not exercised yet. Only `connectionString` is
 * passed, so `max` stays at the driver default of 10 and nothing is reserved
 * for the queue. Written as a TODO rather than left as a claim the code does
 * not keep — the sizing needs a deployment to size against.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Comprobación de vida para el endpoint de salud. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
