import { DEV_PASSWORD } from '../prisma/seed.mts';

import { provenDevLogin } from './dev-api-target.mts';

/**
 * The guard of `dev-api-target.mts`, for scripts that are not Node.
 *
 * Logs in as `admin@clinica.ec` of the seed on `API_URL`, proves the API
 * writes to the database of this checkout's `DATABASE_URL` (and is not the
 * shared `clinica`), and only then prints `{ apiUrl, accessToken }` as JSON on
 * stdout. On a refusal it prints the reason on stderr and exits 1, having
 * closed the session it opened. `scripts/recorrer-el-flujo.py` calls it.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Este guion es solo de desarrollo.');
  process.exit(1);
}

try {
  const session = await provenDevLogin({
    env: process.env,
    argv: process.argv,
    email: 'admin@clinica.ec',
    password: DEV_PASSWORD,
  });
  console.log(JSON.stringify(session));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
