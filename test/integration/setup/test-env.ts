/**
 * Environment for tests that boot the real `AppModule`.
 *
 * Configuration is validated with Zod at startup and the process refuses to
 * run without it — deliberately, so a missing secret fails at boot instead of
 * at midnight. The consequence is that any test starting the application needs
 * a complete environment, and depending on a developer's `.env` would make the
 * test pass locally and fail in CI. That is exactly what happened.
 *
 * Values are OBVIOUSLY fake. Nothing here is dialled, connected to or signed
 * with: the tests that use this only inspect route metadata and shut the
 * application down again. If a test ever does connect using one of these, the
 * host `not-a-real-host` makes the failure immediate and self-explanatory
 * rather than mysterious.
 *
 * Only fills what is absent, so a real environment always wins.
 */
const PLACEHOLDERS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://placeholder:placeholder@not-a-real-host:5432/placeholder', // prettier-ignore
  // Not real keys, and not valid ones: no test here signs anything.
  JWT_PRIVATE_KEY: 'not-a-real-private-key',
  JWT_PUBLIC_KEY: 'not-a-real-public-key',
  // 44 characters, which is what the schema demands of a base64 32-byte key.
  MFA_ENCRYPTION_KEY: 'x'.repeat(44),
  S3_ENDPOINT: 'http://not-a-real-host:9000',
  S3_ACCESS_KEY: 'not-a-real-access-key',
  S3_SECRET_KEY: 'not-a-real-secret-key',
  SMTP_HOST: 'not-a-real-host',
  SMTP_FROM: 'no-responder@clinica.ec',
};

export function useTestEnvironment(): void {
  for (const [key, value] of Object.entries(PLACEHOLDERS)) {
    process.env[key] ??= value;
  }
}
