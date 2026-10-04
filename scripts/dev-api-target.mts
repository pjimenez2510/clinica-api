import { createHash } from 'node:crypto';

import pg from 'pg';

/**
 * WHICH DATABASE A DEVELOPMENT SCRIPT IS ABOUT TO WRITE TO, PROVED.
 *
 * On 01-10-2026 `pnpm sri:certificate:dev` ran from a worktree whose `.env`
 * still said `PORT=3000`. It reached the API on `main`, connected to the
 * shared `clinica` database, uploaded the development certificate and
 * deactivated the author's real one — which cannot be reactivated
 * (`signing_certificate_is_immutable`).
 *
 * A port says nothing about the database behind it. What does: the login
 * just issued a refresh token, and the API stores its SHA-256. If that hash
 * is in the database of this script's own `DATABASE_URL`, that is where the
 * API writes; if not, the API is on another one. And even then, `clinica` —
 * the author's — is refused unless the flag says so on purpose.
 */
const SHARED_DATABASE = 'clinica';
export const ALLOW_SHARED_FLAG = '--i-know-this-is-the-shared-db';

/** No default: `PORT` is precisely what was copied from `main`. */
export function requireApiUrl(env: Record<string, string | undefined>): string {
  const url = env.API_URL?.trim();
  if (!url) {
    throw new Error(
      'Falta API_URL. Póngala en el .env del worktree con el puerto de SU API ' +
        '(nunca la de main, :3000): este guion no supone ninguno.',
    );
  }
  // The base, without a trailing `/`: callers append `/api/v1/...`.
  return url.replace(/\/+$/, '');
}

/** The refresh token out of the login's `Set-Cookie` (`refresh` or `__Host-refresh`). */
export function refreshTokenFrom(setCookies: readonly string[]): string | null {
  for (const cookie of setCookies) {
    const match = /^(?:__Host-)?refresh=([^;]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

export async function tokenIsIn(
  databaseUrl: string,
  refreshToken: string,
): Promise<boolean> {
  const hash = createHash('sha256').update(refreshToken).digest('hex');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT 1 FROM "refresh_token" WHERE "token_hash" = $1',
      [hash],
    );
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}

export async function checkDevApiTarget(options: {
  databaseUrl: string;
  refreshToken: string;
  allowShared: boolean;
  lookup: (databaseUrl: string, refreshToken: string) => Promise<boolean>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const name = decodeURIComponent(
    new URL(options.databaseUrl).pathname.replace(/^\//, ''),
  );
  if (!(await options.lookup(options.databaseUrl, options.refreshToken))) {
    return {
      ok: false,
      reason:
        `La API a la que apunta API_URL escribe en otra base, no en «${name}» ` +
        '(la de DATABASE_URL de este .env). Corrija API_URL o arranque la API de este worktree.',
    };
  }
  if (name === SHARED_DATABASE && !options.allowShared) {
    return {
      ok: false,
      reason:
        `La API escribe en «${SHARED_DATABASE}», la base compartida del autor. ` +
        `Use la base propia del worktree; ${ALLOW_SHARED_FLAG} existe, pero nadie debería usarlo.`,
    };
  }
  return { ok: true };
}

/**
 * Logs in as `email` on `API_URL` and returns the session only once the
 * guard has proved where that API writes. On a refusal the session just
 * opened over there is closed, so nothing is left behind in a database that
 * is not ours, and the error carries the reason.
 *
 * Shared by `sri:certificate:dev` and, through `dev-api-login.mts`, by
 * `scripts/recorrer-el-flujo.py`.
 */
export async function provenDevLogin(options: {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  email: string;
  password: string;
}): Promise<{ apiUrl: string; accessToken: string }> {
  const apiUrl = requireApiUrl(options.env);
  const databaseUrl = options.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Falta DATABASE_URL: sin ella no se puede saber a qué base escribe la API.',
    );
  }

  const login = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!login.ok) {
    throw new Error(
      `No se pudo iniciar sesión en ${apiUrl} (${login.status}). ¿Está la API levantada?`,
    );
  }
  const { accessToken } = (await login.json()) as { accessToken: string };

  const refreshToken = refreshTokenFrom(login.headers.getSetCookie());
  const target = refreshToken
    ? await checkDevApiTarget({
        databaseUrl,
        refreshToken,
        allowShared: options.argv.includes(ALLOW_SHARED_FLAG),
        lookup: tokenIsIn,
      })
    : {
        ok: false as const,
        reason:
          'El inicio de sesión no devolvió la cookie de sesión: no se sigue.',
      };
  if (!target.ok) {
    await fetch(`${apiUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
    throw new Error(target.reason);
  }
  return { apiUrl, accessToken };
}
