import { z } from 'zod';

/**
 * Environment variable schema.
 *
 * Validated at startup (fail fast). A process that boots with incomplete
 * configuration and fails three hours later, on the first invoice, is far
 * worse than one that refuses to start.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

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
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /** Encrypts TOTP secrets at rest (AES-256-GCM -> 32 bytes in base64). */
  MFA_ENCRYPTION_KEY: z.string().min(44),

  // --- Infrastructure ---
  REDIS_URL: z.url().startsWith('redis').optional(),

  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('clinica'),
  S3_REGION: z.string().default('us-east-1'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.email(),

  // --- Ecuadorian context ---
  /**
   * SRI environment: 1 = testing, 2 = production.
   * Declared explicitly so that issuing against production is a conscious
   * decision and never the result of a forgotten default.
   */
  SRI_ENVIRONMENT: z.enum(['1', '2']).default('1'),
  SRI_ISSUER_RUC: z.string().length(13).optional(),

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

  /** Allowed origins, comma separated. Never '*' with health data. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates and returns the configuration. Throws with a readable message when
 * it fails: a raw `ZodError` is unreadable at 3am during a deployment.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

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
