import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './modules/auth/auth.module';
import { validateEnv } from './shared/config/env.schema';
import { TimeoutInterceptor } from './shared/http/interceptors/timeout.interceptor';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter';
import { SharedInfrastructureModule } from './shared/infrastructure/shared-infrastructure.module';
import type { Env } from './shared/config/env.schema';
import { buildLoggerConfig } from './shared/observability/logger.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Validated at startup: if a variable is missing the process does not
      // boot. Better than failing three hours later on the first invoice.
      validate: validateEnv,
    }),

    /**
     * Structured logging with three layers of health-data redaction: allowlist
     * serializers, `redact` as a net, and a final prune of the object.
     * See `shared/observability/log-privacy.ts`.
     */
    // forRootAsync so the logger is built from VALIDATED configuration. Read
    // straight from `process.env` at import time, a bad LOG_LEVEL blew up with
    // a pino error instead of the readable message the schema produces —
    // cancelling the fail-fast exactly where it is most visible.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerConfig({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
          APP_VERSION: config.get('APP_VERSION', { infer: true }),
        }),
    }),

    /**
     * Per-request context over AsyncLocalStorage.
     * Propagates requestId, userId and siteId without polluting every function
     * signature — which is what keeps the domain free of NestJS.
     */
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true },
    }),

    /**
     * Rate limiting at the GUARD layer: it runs before anything expensive.
     * Three windows to tell a short burst apart from sustained abuse.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: 1_000, limit: 5 },
        { name: 'medium', ttl: 10_000, limit: 30 },
        { name: 'long', ttl: 60_000, limit: 150 },
      ],
    }),

    SharedInfrastructureModule,
    AuthModule,
  ],
  providers: [
    // Registered with APP_FILTER, not useGlobalFilters, so the filter can
    // receive HttpAdapterHost by injection.
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Cuts off stuck requests before they exhaust the connection pool.
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
  ],
})
export class AppModule {}
