import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
// `Logger` is the adapter NestJS uses internally; `PinoLogger` is the one that
// takes a structured object as its first argument. They are not interchangeable.
import { Logger as NestPinoLogger, PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { enableBigIntSerialisation } from './shared/bigint-json';
import type { Env } from './shared/config/env.schema';

async function bootstrap(): Promise<void> {
  // Before anything can serialise a response: Prisma returns BigInt for
  // bigserial ids and JSON.stringify throws on them.
  enableBigIntSerialisation();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    /**
     * MUST be false for the body limit in `configureApp` to mean anything.
     *
     * Without it the Express adapter registers its own JSON parser during
     * `create()` — with the default 100 KB — and the first parser to see a
     * request wins. `useBodyParser('json', { limit: '1mb' })` then registers a
     * second one that never runs, so the documented 1 MB was actually 100 KB.
     * It failed safe, which is exactly why nobody noticed.
     */
    bodyParser: false,
  });

  // `bufferLogs: true` above holds the startup logs until this point, so they
  // also go through PHI redaction instead of the default logger.
  app.useLogger(app.get(NestPinoLogger));

  configureApp(app);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  // Data as structured fields, never interpolated into the message. There is
  // only a port number here, but the ESLint rule does not discriminate — and
  // rightly so: by the time someone interpolates a cedula, the habit is set.
  //
  // `resolve` and not `get`: PinoLogger is a request-scoped provider and
  // `get()` throws on scoped providers.
  const logger = await app.resolve(PinoLogger);
  logger.info(
    { port, docs: config.get('NODE_ENV', { infer: true }) !== 'production' },
    'API started',
  );
}

void bootstrap();
