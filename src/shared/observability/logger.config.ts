import { randomUUID } from 'node:crypto';

import type { Params } from 'nestjs-pino';

import {
  pruneToAllowlist,
  sanitizeErrorMessage,
  sanitizeUrl,
} from './log-privacy';

const isProduction = process.env.NODE_ENV === 'production';

/** Headers that may be logged. Everything else is dropped. */
const ALLOWED_HEADERS = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'x-request-id',
  'traceparent',
] as const;

/**
 * Minimal shapes of what pino-http hands to each serializer.
 * Declared by hand because the package types are `any`, and typing the input
 * is what lets the linter catch access to a field that does not exist.
 */
interface RawRequest {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  route?: { path?: string };
}

interface RawResponse {
  statusCode?: number;
  raw?: { statusCode?: number };
}

interface RawError {
  name?: string;
  constructor?: { name?: string };
  message?: string;
  code?: unknown;
  stack?: string;
  /** `pg` connection failures arrive grouped here. */
  errors?: Array<{ code?: unknown; message?: string }>;
}

/**
 * `redact` denylist. This is the SECOND net, not the main defence: the first
 * one is the allowlist in `formatters.log`.
 *
 * Wildcards are kept to a minimum on purpose: without them the cost is ~2% over
 * `JSON.stringify`; with them it rises to around 50%.
 *
 * Paths are compiled inside a VM context, so they must NEVER come from user
 * input or from editable configuration.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'cedula',
  'ruc',
  'firstName',
  'lastName',
  'diagnosis',
  'patient',
  'body',
  'req.body',
];

export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

    base: {
      service: 'clinica-api',
      version: process.env.APP_VERSION ?? '0.1.0',
      env: process.env.NODE_ENV ?? 'development',
    },

    /**
     * One identifier to search everywhere. Once OpenTelemetry is wired in, this
     * will reuse the active trace's `trace_id` so a single event does not end
     * up with two different identifiers.
     */
    genReqId(
      req: { headers: Record<string, unknown> },
      res: { setHeader: (name: string, value: string) => unknown },
    ): string {
      const incoming = req.headers['x-request-id'];
      // ALWAYS validate the incoming header: without this there is log forging,
      // a client could inject newlines and fabricate log entries.
      const valid =
        typeof incoming === 'string' &&
        incoming.length <= 128 &&
        /^[A-Za-z0-9._-]+$/.test(incoming);

      const id = valid ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },

    /** LAYER 1 — allowlist serializers: what gets logged is built explicitly. */
    serializers: {
      req(req: RawRequest) {
        const headers: Record<string, unknown> = {};
        for (const h of ALLOWED_HEADERS) {
          const value = req.headers?.[h];
          if (value !== undefined) headers[h] = value;
        }
        return {
          id: req.id,
          method: req.method,
          url: sanitizeUrl(req.url), // no query string
          route: req.route?.path,
          headers,
          // The IP is OMITTED: it is personal data under LOPDP. When it is
          // needed to investigate improper access it goes to the audit table —
          // where it is declared in the processing register — not to general logs.
        };
      },
      // pino-http wraps the response: depending on the lifecycle stage the real
      // status lives in `res.raw`. Without this fallback every request logs
      // `statusCode: null`, which is worse than no access log because it looks
      // correct.
      res: (res: RawResponse) => ({
        statusCode: res.statusCode ?? res.raw?.statusCode ?? null,
      }),
      err: (err: RawError) => {
        // `pg` groups connection failures under `errors[]` and leaves the top
        // level message and code empty. Without this rescue the log only says
        // `type: "Object", message: ""` and is useless for diagnosis.
        const grouped = err?.errors?.[0];
        return {
          type: err?.name ?? err?.constructor?.name ?? 'Error',
          // Prisma and pg errors embed the row that caused the conflict.
          message: sanitizeErrorMessage(err?.message || grouped?.message),
          code: err?.code ?? grouped?.code,
          stack: isProduction ? undefined : err?.stack,
          // err.query, err.parameters and err.detail are NEVER serialized.
        };
      },
    },

    /** LAYER 2 — denylist as a safety net. */
    redact: {
      paths: REDACT_PATHS,
      censor: '[PHI_REDACTED]',
      // The marker is kept instead of removing the key: a visible absence is
      // auditable, a field that is simply missing says nothing.
      remove: false,
    },

    /** LAYER 3 — allowlist pruning over the merged object. Fails closed. */
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) =>
        pruneToAllowlist(object) as Record<string, unknown>,
    },

    autoLogging: {
      ignore: (req: { url?: string }) =>
        ['/api/v1/health', '/api/v1/ping'].includes(
          (req.url ?? '').split('?')[0],
        ),
    },

    quietReqLogger: true,

    transport: isProduction
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  },
};
