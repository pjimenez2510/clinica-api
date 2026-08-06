import { Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { Env } from './shared/config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService<Env, true>);
  const esProduccion = config.get('NODE_ENV', { infer: true }) === 'production';

  /**
   * ORDEN DELIBERADO. En NestJS el ciclo es:
   *   middleware → guards → interceptors → pipes → controlador
   *              → interceptors (en orden INVERSO) → exception filters
   *
   * Lo de aquí abajo es capa de plataforma: corre antes que todo eso.
   */

  // 1. Cabeceras de seguridad, lo primero.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // 2. CORS restrictivo. Nunca '*' con datos de salud.
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'Accept-Language',
      'traceparent',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Content-Language', 'Retry-After'],
    maxAge: 600,
  });

  // 3. Límite de payload. Una historia clínica en JSON no llega a 1 MB;
  //    los adjuntos van a object storage, no por el cuerpo de la petición.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  // La compresión se delega a nginx: comprimir en el event loop compite con el
  // trabajo de la aplicación y abre la puerta a BREACH sobre respuestas con PHI.

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  // OpenAPI: es el contrato del que el frontend genera sus tipos.
  // Fuera de producción para no exponer la superficie de la API.
  if (!esProduccion) {
    const documento = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('API Clínica')
        .setDescription('Sistema de gestión clínica — Ecuador')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, documento, {
      jsonDocumentUrl: 'api/docs/openapi.json',
    });
  }

  const puerto = config.get('PORT', { infer: true });
  await app.listen(puerto, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API escuchando en http://localhost:${puerto}/api`);
  if (!esProduccion) {
    logger.log(`OpenAPI en http://localhost:${puerto}/api/docs`);
  }
}

void bootstrap();
