import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment for tests that boot the real `AppModule`.
 *
 * Wired as a Vitest `setupFile`, and it has to be. `ConfigModule.forRoot()`
 * runs when `app.module.ts` is IMPORTED, and ESM evaluates every import before
 * the first statement of the test file — so calling this from inside a spec is
 * already too late. It passed locally anyway because Vitest loads `.env`, and
 * failed in CI, which has none.
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
/**
 * A throwaway Ed25519 pair, generated on every run.
 *
 * NOT a constant in the repository. A private key committed to source control
 * looks like a leak to every secret scanner that reads it, and the fact that
 * this one is worthless is not visible from the outside. Generating it costs
 * under a millisecond and cannot be mistaken for a real credential.
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const PLACEHOLDERS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://placeholder:placeholder@not-a-real-host:5432/placeholder', // prettier-ignore
  // Real PKCS#8 and SPKI, because the token service parses them at startup —
  // and worthless, because the pair dies with the process.
  JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), // prettier-ignore
  JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  // 32 zero bytes in base64. It has to DECODE to 32 bytes, not merely be 44
  // characters long — the first attempt was 44 x's, which decodes to 33 and
  // was rejected by the same validation that protects production.
  MFA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  S3_ENDPOINT: 'http://not-a-real-host:9000',
  S3_ACCESS_KEY: 'not-a-real-access-key',
  S3_SECRET_KEY: 'not-a-real-secret-key',
  SMTP_HOST: 'not-a-real-host',
  SMTP_FROM: 'no-responder@clinica.ec',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  process.env[key] ??= value;
}

/**
 * THE SRI, FORCED AND NOT DEFAULTED — the one exception to «a real environment
 * wins», on purpose.
 *
 * - `SRI_QUEUE_ENABLED=false`: a developer's `.env` leaves it on, and an
 *   `AppModule` booted here would start pg-boss against whatever
 *   `DATABASE_URL` the config holds — the developer's own database. The specs
 *   that exercise the queue start it themselves, against the container.
 * - No web-service URLs: no spec that boots the application may reach any
 *   SRI, local or not. The flow specs build their client against the local
 *   double explicitly.
 * - A master passphrase in a throwaway file, so the certificate store works
 *   and nothing of a developer's `.dev-secrets/` is read.
 * - `01` as payment method: a TEST VALUE, not D-092's answer.
 */
const sriMasterKeyFile = join(
  mkdtempSync(join(tmpdir(), 'sri-test-')),
  'master',
);
writeFileSync(sriMasterKeyFile, 'frase-maestra-de-las-pruebas-de-integracion');

process.env.SRI_QUEUE_ENABLED = 'false';
process.env.SRI_CERTIFICATE_MASTER_KEY_FILE = sriMasterKeyFile;
process.env.SRI_DEFAULT_PAYMENT_METHOD = '01';
process.env.SRI_ALLOW_REMOTE = 'false';
// EMPTY and not deleted: `ConfigModule` falls back to the `.env` file for a
// variable the process does not have, and `KEY=` reads as «not declared».
process.env.SRI_RECEPTION_URL = '';
process.env.SRI_AUTHORISATION_URL = '';
process.env.SRI_SOFTWARE_PROVIDER_RUC = '';
