import { z } from 'zod';

/**
 * Environment variable schema.
 *
 * Validated at startup (fail fast). A process that boots with incomplete
 * configuration and fails three hours later, on the first invoice, is far
 * worse than one that refuses to start.
 */
/** `KEY=` in a `.env` file means «not declared», not «declared empty». */
function emptyAsUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * How many reverse proxies sit in front of the API.
   *
   * A COUNT, never `true`. With `trust proxy: true` Express believes the whole
   * `X-Forwarded-For` chain, so any client can prepend a forged address, get a
   * fresh rate-limit bucket on every request and walk past the login throttle.
   * A count makes Express skip exactly that many hops from the right and take
   * the next one, which cannot be spoofed.
   *
   * 0 means the API is exposed directly. Getting this wrong is not cosmetic:
   * with a proxy in front and 0 here, every client shares one bucket, so a
   * single attacker exhausts the login limit for the whole clinic — and the IP
   * recorded against each session is the proxy's, which makes the LOPDP audit
   * trail useless for investigating improper access.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Always UTC. No date conversion may depend on the server's timezone:
   * appointments render in the site's timezone, not the host's.
   */
  TZ: z.literal('UTC').default('UTC'),

  DATABASE_URL: z.url().startsWith('postgres'),

  // --- Authentication ---
  /**
   * Ed25519 keys in PEM. EdDSA rather than HS256: with an asymmetric key,
   * workers verify tokens without being able to issue them. With HMAC, whoever
   * can verify can forge.
   */
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  /**
   * A duration, not any string. `z.string()` accepted `"banana"`, and the
   * failure then surfaced when the FIRST token was issued rather than at
   * startup — which is the whole point of validating configuration.
   */
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'debe ser una duración como 15m, 2h o 7d')
    .default('15m'),
  /**
   * AU-040. The ABSOLUTE life of a session, counted from sign-in: every
   * refresh token of the family inherits the expiry of the first, so rotating
   * never extends it. Seven days is the author's decision (D-063); an
   * installation may shorten it, in whole days, never lengthen it. The cut is
   * brought FORWARD to the last 03:00 in Guayaquil before it (AU-043), so the
   * real life lies between N − 1 and N days.
   */
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().max(7).default(7),
  /**
   * AU-039. Seconds during which the refresh token just rotated may be
   * presented again — by the same client — without revoking its family: the
   * response carrying its successor may never have reached the browser.
   * Default and ceiling are Okta's (30 s, 0–60); 0 turns the grace off and
   * leaves AU-004 strict. The reasoning and sources are in the auth SPEC.
   */
  JWT_REFRESH_REUSE_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60)
    .default(30),

  /**
   * Encrypts TOTP secrets at rest. AES-256-GCM, so it must DECODE to 32 bytes.
   *
   * `.min(44)` only checked the length of the base64 text, which 44 x's
   * satisfies while decoding to 33. `TotpService` then rejected it in its
   * constructor — so the process did die at startup, but with the wrong
   * message from the wrong place.
   */
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, 'base64').length === 32,
      'debe decodificar a exactamente 32 bytes (AES-256-GCM)',
    ),

  // --- Infrastructure ---
  REDIS_URL: z.url().startsWith('redis').optional(),

  /**
   * OPTIONAL until an adapter reads them.
   *
   * Requiring configuration for features that do not exist forces whoever sets
   * the system up to invent values, and a fail-fast that cries wolf is one
   * people learn to work around. They become required the day attachments are
   * implemented.
   */
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).default('clinica'),
  S3_REGION: z.string().default('us-east-1'),

  /**
   * OPTIONAL EVEN THOUGH MAIL NOW HAS AN ADAPTER (AU-021, D-013).
   *
   * Making them required would stop an installation that never creates an
   * account from booting, which is a worse failure than the one it prevents.
   * The refusal happens at the POINT OF USE instead — `MAIL_NOT_CONFIGURED` —
   * so the administrator who tries to invite somebody is told what is missing,
   * by name, at the moment it matters, and the account is still created
   * (AU-029).
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.email().optional(),

  /**
   * Where the BROWSER lives, so a link in an e-mail can point at a screen.
   *
   * The API cannot render the page that asks somebody for a new password: it
   * is `clinica-web` that owns `/acceso/credencial`. Without this the
   * invitation of AU-021 would have to point at the API, which would answer
   * JSON to a person expecting a form.
   *
   * Defaulted for development because that is where `clinica-web` runs; in
   * production it is the public address of the interface, and getting it wrong
   * produces an invitation nobody can open.
   */
  WEB_BASE_URL: z.url().default('http://localhost:3001'),

  // --- Ecuadorian context ---
  /**
   * SRI environment: 1 = testing, 2 = production.
   * Declared explicitly so that issuing against production is a conscious
   * decision and never the result of a forgotten default.
   */
  SRI_ENVIRONMENT: z.enum(['1', '2']).default('1'),
  /**
   * UNUSED BY THE VOUCHER, on purpose: the issuer's RUC is the establishment's
   * (`organization`, OR-008), the one the RIDE already prints. Two sources for
   * one datum is how a voucher ends up signed under one RUC and keyed under
   * another. Kept only so existing `.env` files keep validating.
   */
  SRI_ISSUER_RUC: z.string().length(13).optional(),

  /**
   * SRI-053, SRI-054. The two offline web services, WITHOUT `?wsdl`. Absent:
   * vouchers are prepared and signed, and wait in the monitor. In development
   * they point at the local double of the SRI (`pnpm sri:double`).
   */
  SRI_RECEPTION_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
  SRI_AUTHORISATION_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
  /**
   * SRI-053. A host that is not local is refused unless this is `true`:
   * reaching the real SRI is a deliberate act of the author (sri/SPEC.md §9),
   * never the side effect of a copied `.env`.
   */
  SRI_ALLOW_REMOTE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** SRI-042. Ceiling per call; the SRI documents none. */
  SRI_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(30_000),
  /**
   * SRI-024. The PATH of the file holding the master passphrase (a Docker
   * secret in production), never the passphrase itself: environment variables
   * leak through `docker inspect`, crash dumps and error reports.
   */
  SRI_CERTIFICATE_MASTER_KEY_FILE: z.preprocess(
    emptyAsUndefined,
    z.string().min(1).optional(),
  ),
  /** SRI-016, D-091. Anexo 26 «RUC Proveedor». Empty: the field is not emitted. */
  SRI_SOFTWARE_PROVIDER_RUC: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .regex(/^[0-9]{13}$/)
      .optional(),
  ),
  /**
   * SRI-040. Whether this process runs the voucher queue (pg-boss). Off in the
   * integration suite, where each spec drives the queue it needs.
   */
  SRI_QUEUE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /** Default site timezone. `Pacific/Galapagos` for the Galapagos islands. */
  DEFAULT_TIMEZONE: z
    .string()
    .default('America/Guayaquil')
    .refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz), {
      message:
        'invalid IANA timezone (remember: it is Pacific/Galapagos, not America/Galapagos)',
    }),

  // --- Observability ---
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  /** Stamped on every log line so an incident can be tied to a deployment. */
  APP_VERSION: z.string().optional(),

  /**
   * Allowed origins, comma separated. Never '*' with health data.
   *
   * Each one is validated as a URL: an extra space or a missing scheme made
   * that origin silently stop working, and the symptom is a CORS failure in
   * the browser with nothing in the server logs.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).describe('lista de orígenes permitidos')),
});

/**
 * The configuration AFTER validation and defaults. Read through
 * `ConfigService<Env, true>`, so every `get` is typed against the schema.
 */
export type Env = z.infer<typeof envSchema>;

/** SRI-055. The SRI's two hosts and the environment each one serves. */
const SRI_HOST_ENVIRONMENT: Record<string, '1' | '2'> = {
  'celcer.sri.gob.ec': '1',
  'cel.sri.gob.ec': '2',
};

/** SRI-053. `localhost`, a loopback address, or a `.localhost`/`.test` name. */
export function isLocalUrl(value: string): boolean {
  const host = new URL(value).hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}

/**
 * Validates and returns the configuration. Throws with a readable message when
 * it fails: a raw `ZodError` is unreadable at 3am during a deployment.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema
    /**
     * `TRUST_PROXY_HOPS` must be DECLARED in production.
     *
     * Its default of 0 is right for development and wrong behind the nginx
     * that almost always sits in front of production — where it puts the whole
     * clinic in one rate-limit bucket and records the proxy's address as every
     * user's. Defaulting silently to the dangerous value is the one case where
     * a default is worse than a refusal to start.
     */
    .superRefine((env, ctx) => {
      // SRI-053. No process reaches a remote SRI by accident.
      for (const key of [
        'SRI_RECEPTION_URL',
        'SRI_AUTHORISATION_URL',
      ] as const) {
        const value = env[key];
        if (
          value !== undefined &&
          !env.SRI_ALLOW_REMOTE &&
          !isLocalUrl(value)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'apunta a un servidor que no es local; declare SRI_ALLOW_REMOTE=true solo si de verdad quiere hablar con el SRI',
          });
        }
        if (value === undefined || isLocalUrl(value)) continue;
        // SRI-053. Toward the real SRI, only over TLS.
        if (new URL(value).protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'el servicio del SRI solo se llama por https',
          });
        }
        // SRI-055. The environment is NOT deduced from the URL, but a key of
        // one environment sent to the other's server is returned for ever:
        // the two must agree, or the process does not start.
        const environmentOfHost = SRI_HOST_ENVIRONMENT[new URL(value).hostname];
        if (
          environmentOfHost !== undefined &&
          environmentOfHost !== env.SRI_ENVIRONMENT
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `es el servidor del ambiente ${environmentOfHost} y SRI_ENVIRONMENT dice ${env.SRI_ENVIRONMENT}: los comprobantes de un ambiente no se autorizan en el otro`,
          });
        }
      }
      if (env.NODE_ENV === 'production' && raw.TRUST_PROXY_HOPS === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY_HOPS'],
          message:
            'debe declararse explícitamente en producción (0 si la API se expone directamente)',
        });
      }
    })
    .safeParse(raw);

  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration. The process will not start:\n${detail}\n\n` +
        `Check your .env file against .env.example.`,
    );
  }

  return result.data;
}
