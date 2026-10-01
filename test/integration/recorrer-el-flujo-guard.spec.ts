import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, inject, it } from 'vitest';

import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * `scripts/recorrer-el-flujo.py` MUST NOT WRITE TO ANOTHER CHECKOUT'S DATABASE.
 *
 * It used to hardcode `http://localhost:3000/api/v1` — the API on `main`, on
 * the author's `clinica` database — and write a whole visit there. Now its
 * session comes from `dev-api-login.mts`, the guard of `sri:certificate:dev`.
 *
 * The script runs for real, against a stand-in API that issues the refresh
 * cookie we choose and records every request. Whether that token is in the
 * database is decided against a real PostgreSQL.
 */
const db = useDatabase();

type Seen = { method: string; path: string };

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function standInApi(refreshToken: string): Promise<{
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '' });
    if (req.url === '/api/v1/auth/login') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `refresh=${refreshToken}; Path=/api/v1/auth; HttpOnly`,
      });
      res.end(JSON.stringify({ accessToken: 'access' }));
      return;
    }
    // Anything else: the script got past the guard. Nothing to give it.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function runScript(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['scripts/recorrer-el-flujo.py'], {
      env: {
        PATH: process.env.PATH ?? '',
        // Any request that is not for the stand-in goes to a dead proxy and
        // fails. If someone hardcoded `localhost:3000` again, this test would
        // otherwise write to the author's database while proving it doesn't.
        http_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        no_proxy: '127.0.0.1',
        NO_PROXY: '127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
        ...env,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function aSessionIn(): Promise<string> {
  const prisma = db();
  const user = await createUser(prisma);
  const token = randomBytes(32).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId: crypto.randomUUID(),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return token;
}

describe('recorrer-el-flujo.py solo escribe en la base de su checkout', () => {
  it('sin API_URL no llama a nada: no supone el puerto de main', async () => {
    const api = await standInApi('irrelevant');
    // Empty, and present: the `.env` of this checkout must not fill it in.
    const run = await runScript({
      API_URL: '',
      DATABASE_URL: inject('databaseUrl'),
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/Falta API_URL/);
    expect(api.seen).toEqual([]);
  });

  it('se niega si la API escribe en otra base: inicia sesión, la cierra y no escribe nada', async () => {
    const elsewhere = randomBytes(32).toString('base64url');
    const api = await standInApi(elsewhere);

    const run = await runScript({
      API_URL: api.url,
      DATABASE_URL: inject('databaseUrl'),
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/escribe en otra base/);
    expect(api.seen).toEqual([
      { method: 'POST', path: '/api/v1/auth/login' },
      { method: 'POST', path: '/api/v1/auth/logout' },
    ]);
  });

  it('con la API de su base, pasa la guarda y empieza el recorrido (control positivo)', async () => {
    const token = await aSessionIn();
    const api = await standInApi(token);

    await runScript({ API_URL: api.url, DATABASE_URL: inject('databaseUrl') });

    // The stand-in answers 404 to everything past the login, so the script
    // stops there; what matters is that it got past the guard, without logout.
    expect(api.seen[0]).toEqual({ method: 'POST', path: '/api/v1/auth/login' });
    expect(api.seen[1]).toEqual({
      method: 'GET',
      path: '/api/v1/organization/sites',
    });
    expect(api.seen).not.toContainEqual({
      method: 'POST',
      path: '/api/v1/auth/logout',
    });
  });
});
