import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { Env } from '../../config/env.schema';

/**
 * Cliente de Prisma con adaptador de driver.
 *
 * Prisma 7 eliminó la URL del schema: el cliente recibe un adaptador construido
 * aquí. La ventaja real es que el pool de conexiones lo controlas tú, no Prisma
 * — importante porque pg-boss comparte la misma base y hay que repartir el cupo.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
