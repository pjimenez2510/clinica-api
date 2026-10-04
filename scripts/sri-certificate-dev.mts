import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DEV_PASSWORD } from '../prisma/seed.mts';
import { createTestPkcs12 } from '../test/support/test-pkcs12.ts';

import { provenDevLogin } from './dev-api-target.mts';

/**
 * `pnpm sri:certificate:dev` — a DEVELOPMENT certificate for the issuer, so the
 * vouchers of a local installation get signed.
 *
 * 1. Creates the master passphrase file `SRI_CERTIFICATE_MASTER_KEY_FILE`
 *    points at, if it does not exist (`.dev-secrets/`, ignored by git).
 * 2. Generates a self-signed PKCS#12 IN MEMORY — never written to disk — and
 *    uploads it through the real route, `POST /api/v1/sri/certificates`, as
 *    `admin@clinica.ec` of the seed. The API has to be running.
 *
 * ⚠️ NEVER THE AUTHOR'S CERTIFICATE. Loading the real one is a step of the
 * author's, from the administration screen (sri/SPEC.md §9).
 *
 * ⚠️ NEVER THE AUTHOR'S DATABASE. `API_URL` is required, with no default, and
 * before uploading anything the script proves the API writes to the database
 * of its own `DATABASE_URL`, and refuses `clinica` (`dev-api-target.mts`).
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Este guion es solo de desarrollo.');
  process.exit(1);
}

const keyFile = resolve(
  process.env.SRI_CERTIFICATE_MASTER_KEY_FILE ?? '.dev-secrets/sri-master-key',
);
if (!existsSync(keyFile)) {
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  console.log(`Frase maestra de desarrollo creada en ${keyFile}`);
}

let api: string;
let accessToken: string;
try {
  ({ apiUrl: api, accessToken } = await provenDevLogin({
    env: process.env,
    argv: process.argv,
    email: 'admin@clinica.ec',
    password: DEV_PASSWORD,
  }));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const p12 = createTestPkcs12({
  now: new Date(),
  validForDays: 730,
  commonName: 'FIRMANTE DE DESARROLLO',
});
const upload = await fetch(`${api}/api/v1/sri/certificates`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    pkcs12Base64: p12.pkcs12.toString('base64'),
    password: p12.password,
  }),
});
console.log(`Certificado de desarrollo: HTTP ${upload.status}`);
console.log(await upload.text());
process.exit(upload.ok ? 0 : 1);
