import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The compiled output actually loads.
 *
 * WHY THIS EXISTS: nothing tested the artifact that gets deployed. Tests run
 * the SOURCE through SWC, which emits ESM and hoists imports; `nest build` runs
 * it through `tsc`, which emits CommonJS and leaves each `require` exactly
 * where the import was written. An import placed below the constant that uses
 * it is therefore invisible to all 137 unit tests and fatal on startup:
 *
 *     ReferenceError: Cannot access 'argon2' before initialization
 *
 * That is what happened. The API had passed every gate and would not boot.
 *
 * Loading `app.module.js` executes the top-level code of every module in the
 * dependency graph, which is the whole class of failure — temporal dead zones,
 * circular imports, a package that is ESM-only in a CommonJS build. It opens no
 * socket and needs no database, so it costs a second and runs in the fast job.
 */
const entry = resolve(import.meta.dirname, '../dist/app.module.js');

if (!existsSync(entry)) {
  console.error(
    `No existe ${entry}. Ejecute "pnpm build" antes de esta comprobación.`,
  );
  process.exit(1);
}

/**
 * A complete, obviously fake environment.
 *
 * The configuration is validated with Zod and the process refuses to run
 * without it — deliberately. Nothing here is connected to: the host
 * `not-a-real-host` makes any accidental connection fail immediately and
 * self-explanatorily. The key pair is generated per run rather than committed,
 * because a private key in the repository looks like a leak to every scanner
 * that reads it.
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const PLACEHOLDERS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://placeholder:placeholder@not-a-real-host:5432/placeholder', // prettier-ignore
  JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), // prettier-ignore
  JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  // 32 zero bytes in base64. It must DECODE to 32 bytes, not merely look long.
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

try {
  await import(entry);
} catch (error) {
  console.error('El artefacto compilado no carga:');
  console.error(error);
  process.exit(1);
}

console.log('El artefacto compilado carga correctamente.');
