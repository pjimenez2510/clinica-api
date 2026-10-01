import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, inject, it } from 'vitest';

import {
  checkDevApiTarget,
  refreshTokenFrom,
  requireApiUrl,
  tokenIsIn,
} from '../../scripts/dev-api-target.mts';

import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * `pnpm sri:certificate:dev` MUST NOT TOUCH THE AUTHOR'S DATABASE.
 *
 * On 01-10-2026 it ran from a worktree whose `.env` still said `PORT=3000`:
 * it uploaded the development certificate to the API on `main`, connected to
 * the shared `clinica` database, and deactivated the author's real one. The
 * guard proves which database the API writes to — the refresh token its login
 * just issued must be in the database of the script's own `DATABASE_URL` —
 * and refuses `clinica`. The lookup runs against a real PostgreSQL.
 */
const db = useDatabase();

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

describe('la guarda de los guiones de desarrollo que llaman a la API', () => {
  it('exige API_URL: sin ella no supone ningún puerto', () => {
    expect(() => requireApiUrl({ PORT: '3000' })).toThrow(/API_URL/);
    expect(requireApiUrl({ API_URL: 'http://localhost:3600' })).toBe(
      'http://localhost:3600',
    );
  });

  it('lee el refresh token de la cookie que puso el inicio de sesión', () => {
    expect(
      refreshTokenFrom([
        'other=1; Path=/',
        'refresh=abc.DEF_123; Path=/api/v1/auth; HttpOnly; SameSite=Strict',
      ]),
    ).toBe('abc.DEF_123');
    expect(refreshTokenFrom(['__Host-refresh=xyz; Path=/; Secure'])).toBe(
      'xyz',
    );
    expect(refreshTokenFrom(['other=1'])).toBeNull();
  });

  it('admite la API que escribe en la base de su DATABASE_URL, y rechaza la que escribe en otra', async () => {
    const databaseUrl = inject('databaseUrl');
    const token = await aSessionIn();

    // Positive control: the same lookup, on the same database, finds it.
    expect(await tokenIsIn(databaseUrl, token)).toBe(true);
    expect(
      await checkDevApiTarget({
        databaseUrl,
        refreshToken: token,
        allowShared: false,
        lookup: tokenIsIn,
      }),
    ).toEqual({ ok: true });

    // A session the database does not hold: the API is on another one.
    const elsewhere = randomBytes(32).toString('base64url');
    const refused = await checkDevApiTarget({
      databaseUrl,
      refreshToken: elsewhere,
      allowShared: false,
      lookup: tokenIsIn,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/otra base/);
  });

  it('rechaza la base compartida «clinica» aunque la API sí escriba en ella, salvo que se diga expresamente', async () => {
    const shared =
      'postgresql://clinica:clinica_dev@localhost:5432/clinica?schema=public';
    const writesThere = () => Promise.resolve(true);

    const refused = await checkDevApiTarget({
      databaseUrl: shared,
      refreshToken: 't',
      allowShared: false,
      lookup: writesThere,
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/clinica/);

    expect(
      await checkDevApiTarget({
        databaseUrl: shared,
        refreshToken: 't',
        allowShared: true,
        lookup: writesThere,
      }),
    ).toEqual({ ok: true });
    // Control: another database name, same everything else, goes through.
    expect(
      await checkDevApiTarget({
        databaseUrl: shared.replace('/clinica?', '/clinica_sri?'),
        refreshToken: 't',
        allowShared: false,
        lookup: writesThere,
      }),
    ).toEqual({ ok: true });
  });
});
