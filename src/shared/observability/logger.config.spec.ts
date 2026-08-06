import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { buildLoggerConfig } from './logger.config';

/**
 * Exercises the REAL pino configuration, not an imitation of it.
 *
 * This suite exists because of a bug that no unit test could have caught:
 * `formatters.log` runs BEFORE the serializers, and `pruneToAllowlist`
 * recurses. Handed a raw `Error` it rebuilt it as a plain object — and
 * `message`, `stack` and `name` are non-enumerable on an Error, so they were
 * gone before the `err` serializer ever ran. Every error log came out as
 * `{"err":{"type":"Object","message":""}}`.
 *
 * `sanitizeErrorMessage` had its own passing tests the whole time. It was
 * simply never called. Testing the pieces in isolation proved nothing about
 * the pipeline they were wired into.
 */
function logAndCapture(
  emit: (logger: pino.Logger) => void,
): Record<string, unknown> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });

  const options = {
    ...buildLoggerConfig({ NODE_ENV: 'test' }).pinoHttp,
  } as pino.LoggerOptions;
  // pino-pretty would reformat the output and hide the shape under test.
  delete (options as { transport?: unknown }).transport;
  options.level = 'debug';

  emit(pino(options, sink));
  return JSON.parse(lines.join('')) as Record<string, unknown>;
}

describe('error logging pipeline', () => {
  it('keeps the diagnostic message on the log entry', () => {
    // An error log with no message cannot reconstruct an improper access,
    // which is precisely what the LOPDP requires us to be able to do.
    const entry = logAndCapture((logger) =>
      logger.error({ err: new Error('constraint agenda_overlap') }, 'failed'),
    );

    expect(entry.err).toMatchObject({
      type: 'Error',
      message: 'constraint agenda_overlap',
    });
  });

  it('keeps the stack trace outside production', () => {
    const entry = logAndCapture((logger) =>
      logger.error({ err: new Error('boom') }, 'failed'),
    );

    expect((entry.err as { stack?: string }).stack).toContain('Error: boom');
  });

  it('redacts a cedula inside the error message', () => {
    // The message survives, but the personal data in it does not.
    const entry = logAndCapture((logger) =>
      logger.error({ err: new Error('cedula 1710034065 rechazada') }, 'failed'),
    );

    const { message } = entry.err as { message: string };
    expect(message).not.toContain('1710034065');
    expect(message).toContain('[CEDULA]');
  });

  it('DROPS everything the allowlist does not name', () => {
    // The pruning still fails closed for everything that is not a serializer
    // key — that is what holding back `err` must not have weakened.
    const entry = logAndCapture((logger) =>
      logger.info(
        { patientName: 'María Guamán', diagnosis: 'F32.1', trace_id: 'abc' },
        'ok',
      ),
    );

    expect(entry.patientName).toBeUndefined();
    expect(entry.diagnosis).toBeUndefined();
    expect(entry.trace_id).toBe('abc');
  });

  it('NEVER serialises the Prisma metadata carrying the failing row', () => {
    // PostgreSQL puts the whole rejected row in `cause.detail`. Prisma hangs
    // it off `err.meta`, and pino's DEFAULT err serializer copies own
    // enumerable properties — which `meta` is.
    const err = Object.assign(new Error('check constraint violated'), {
      code: 'P2039',
      meta: {
        driverAdapterError: {
          cause: {
            detail: 'Failing row contains (Juan, Perez, 1710034065)',
          },
        },
      },
    });

    const entry = logAndCapture((logger) => logger.error({ err }, 'failed'));

    expect(JSON.stringify(entry)).not.toContain('Failing row');
    expect(JSON.stringify(entry)).not.toContain('1710034065');
    expect((entry.err as { code?: string }).code).toBe('P2039');
  });
});
