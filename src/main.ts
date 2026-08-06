import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
// `Logger` is the adapter NestJS uses internally; `PinoLogger` is the one that
// takes a structured object as its first argument. They are not interchangeable.
import { Logger as NestPinoLogger, PinoLogger } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';

import { AppModule } from './app.module';
import type { Env } from './shared/config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // `bufferLogs: true` above holds the startup logs until this point, so they
  // also go through PHI redaction instead of the default logger.
  app.useLogger(app.get(NestPinoLogger));

  const config = app.get(ConfigService<Env, true>);
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  /**
   * Who the client actually is, when there is a proxy in front.
   *
   * Without this `req.ip` is the proxy's address for every request, and two
   * things break at once: the rate limiter puts the entire clinic in one
   * bucket — so a single attacker exhausts the ten login attempts per minute
   * for everybody — and the IP stored alongside each session, which is the
   * trail the LOPDP expects us to follow when investigating improper access,
   * points at our own infrastructure.
   *
   * A COUNT of hops, never `true`: trusting the whole `X-Forwarded-For` chain
   * lets a client prepend a forged address and mint itself a fresh bucket on
   * every request.
   */
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  /**
   * DELIBERATE ORDER. The NestJS lifecycle is:
   *   middleware -> guards -> interceptors -> pipes -> controller
   *              -> interceptors (REVERSE order) -> exception filters
   *
   * Everything below is platform level: it runs before all of that.
   */

  // 1. Security headers, first of all.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // 2. Restrictive CORS. Never '*' with health data.
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

  // 3. Payload limit. A clinical record in JSON never reaches 1 MB; attachments
  //    go to object storage, not through the request body.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  // Compression is delegated to nginx: compressing inside the event loop
  // competes with application work and opens the door to BREACH on responses
  // that carry PHI.

  // Needed to read the refresh token, which only ever travels in an httpOnly
  // cookie so an injected script cannot reach it.
  app.use(cookieParser());

  // Spanish as the FALLBACK for validation messages. Its wording is machine
  // translated and reads poorly ("Inválido dirección de correo electrónico"),
  // so every user-facing field should still declare its own message in the
  // schema. This only ensures nothing ever surfaces in English.
  z.config(z.locales.es());

  // Validation runs as a PIPE, which means it happens AFTER guards. Never take
  // an authorization decision from the body inside a guard: it is unvalidated
  // at that point.
  app.useGlobalPipes(new ZodValidationPipe());

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  // OpenAPI: the contract the frontend generates its types from.
  // Disabled in production so the API surface is not exposed.
  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('API Clinica')
        .setDescription('Clinical management system — Ecuador')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/docs/openapi.json',
    });
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  // Data as structured fields, never interpolated into the message. There is
  // only a port number here, but the ESLint rule does not discriminate — and
  // rightly so: by the time someone interpolates a cedula, the habit is set.
  //
  // `resolve` and not `get`: PinoLogger is a request-scoped provider and
  // `get()` throws on scoped providers.
  const logger = await app.resolve(PinoLogger);
  logger.info({ port, docs: !isProduction }, 'API started');
}

void bootstrap();
