import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { validarEnv } from './shared/config/env.schema';
import { TimeoutInterceptor } from './shared/http/interceptors/timeout.interceptor';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter';
import { SharedInfrastructureModule } from './shared/infrastructure/shared-infrastructure.module';
import { loggerConfig } from './shared/observability/logger.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Valida al arrancar: si falta una variable, el proceso no levanta.
      // Es preferible a fallar tres horas después, en la primera factura.
      validate: validarEnv,
    }),

    /**
     * Logging estructurado con redacción de datos de salud en tres capas:
     * serializadores de allowlist, `redact` como red, y poda final del objeto.
     * Ver `shared/observability/log-privacy.ts`.
     */
    LoggerModule.forRoot(loggerConfig),

    /**
     * Contexto por petición sobre AsyncLocalStorage.
     * Propaga requestId, usuarioId y sedeId sin ensuciar la firma de cada
     * función — que es lo que permite mantener el dominio libre de NestJS.
     */
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true },
    }),

    /**
     * Rate limiting en capa de GUARD: corre antes de que se ejecute nada caro.
     * Tres ventanas para distinguir una ráfaga puntual de un abuso sostenido.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'corta', ttl: 1_000, limit: 5 },
        { name: 'media', ttl: 10_000, limit: 30 },
        { name: 'larga', ttl: 60_000, limit: 150 },
      ],
    }),

    SharedInfrastructureModule,
  ],
  providers: [
    // Se registra con APP_FILTER, no con useGlobalFilters, para que el filtro
    // pueda recibir HttpAdapterHost por inyección.
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Corta las peticiones colgadas antes de que agoten el pool de conexiones.
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
  ],
})
export class AppModule {}
