import { z } from 'zod';

/**
 * Esquema de las variables de entorno.
 *
 * Se valida al arrancar (fail-fast). Un proceso que levanta con configuración
 * incompleta y falla tres horas después, en la primera factura, es mucho peor
 * que uno que no arranca.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * Siempre UTC. Ninguna conversión de fecha puede depender de la zona horaria
   * del servidor: las citas se renderizan en la zona de la sede, no en la del host.
   */
  TZ: z.literal('UTC').default('UTC'),

  DATABASE_URL: z.url().startsWith('postgres'),

  // --- Autenticación ---
  /**
   * Claves Ed25519 en PEM. EdDSA y no HS256: con clave asimétrica los workers
   * verifican tokens sin poder emitirlos. Con HMAC, quien verifica puede falsificar.
   */
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DIAS: z.coerce.number().int().positive().default(7),

  /** Cifra los secretos TOTP en reposo (AES-256-GCM → 32 bytes en base64). */
  MFA_ENCRYPTION_KEY: z.string().min(44),

  // --- Infraestructura ---
  REDIS_URL: z.url().startsWith('redis').optional(),

  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('clinica'),
  S3_REGION: z.string().default('us-east-1'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.email(),

  // --- Contexto ecuatoriano ---
  /**
   * Ambiente del SRI: 1 = pruebas, 2 = producción.
   * Se declara explícitamente para que emitir contra producción sea una decisión
   * consciente y no el resultado de un valor por defecto olvidado.
   */
  SRI_AMBIENTE: z.enum(['1', '2']).default('1'),
  SRI_RUC_EMISOR: z.string().length(13).optional(),

  /** Zona por defecto de la sede. `Pacific/Galapagos` para Galápagos. */
  ZONA_HORARIA_DEFECTO: z
    .string()
    .default('America/Guayaquil')
    .refine((z_) => Intl.supportedValuesOf('timeZone').includes(z_), {
      message:
        'zona horaria IANA inválida (recuerda: es Pacific/Galapagos, no America/Galapagos)',
    }),

  // --- Observabilidad ---
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  /** Orígenes permitidos, separados por coma. Nunca '*' con datos de salud. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valida y devuelve la configuración. Lanza con un mensaje legible si falla:
 * `ZodError` en crudo es ilegible a las 3 de la mañana durante un despliegue.
 */
export function validarEnv(raw: Record<string, unknown>): Env {
  const resultado = envSchema.safeParse(raw);

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');

    throw new Error(
      `Configuración de entorno inválida. El proceso no arranca:\n${detalle}\n\n` +
        `Revisa tu archivo .env contra .env.example.`,
    );
  }

  return resultado.data;
}
