import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { AuthService, InvalidCredentialsError } from './auth.service';
import type {
  AuthUser,
  AuthUserRepositoryPort,
  PasswordHasherPort,
  RefreshTokenPort,
  TokenIssuerPort,
  TotpPort,
} from './ports';

/**
 * Sign-in must not tell an anonymous caller who works here.
 *
 * This is what the ports were built for. Running these against real Argon2 and
 * a real PostgreSQL would cost ~100 ms per hash, and the tests covering the
 * most security-sensitive path in the system would end up too slow to run.
 */

const CORRECT = 'la contraseña correcta';

function buildUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'medico@clinica.ec',
    passwordHash: 'hash-of-the-correct-password',
    firstName: 'Ana',
    lastName: 'Villacís',
    cedula: null,
    active: true,
    mfaSecretEncrypted: null,
    mfaEnabledAt: null,
    mfaLastStep: null,
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

describe('sign-in does not reveal who works here', () => {
  /**
   * The doubles are held in named variables rather than reached through the
   * port objects. Referencing `hasher.verify` to assert on it is an unbound
   * method access, which the linter rejects for good reason.
   */
  let findByEmail: Mock<AuthUserRepositoryPort['findByEmail']>;
  let recordFailedAttempt: Mock<AuthUserRepositoryPort['recordFailedAttempt']>;
  let clearFailedAttempts: Mock<AuthUserRepositoryPort['clearFailedAttempts']>;
  let verify: Mock<PasswordHasherPort['verify']>;
  let burnTime: Mock<PasswordHasherPort['burnTime']>;
  let warn: Mock<(context: object, message: string) => void>;
  let service: AuthService;

  beforeEach(() => {
    findByEmail = vi
      .fn<AuthUserRepositoryPort['findByEmail']>()
      .mockResolvedValue(null);
    recordFailedAttempt = vi
      .fn<AuthUserRepositoryPort['recordFailedAttempt']>()
      .mockResolvedValue(undefined);
    clearFailedAttempts = vi
      .fn<AuthUserRepositoryPort['clearFailedAttempts']>()
      .mockResolvedValue(undefined);
    verify = vi.fn<PasswordHasherPort['verify']>((_hash, plain) =>
      Promise.resolve(plain === CORRECT),
    );
    burnTime = vi
      .fn<PasswordHasherPort['burnTime']>()
      .mockResolvedValue(undefined);
    warn = vi.fn<(context: object, message: string) => void>();

    const users: AuthUserRepositoryPort = {
      findByEmail,
      findById: vi.fn(),
      findByRefreshFamily: vi.fn(),
      updatePasswordHash: vi.fn().mockResolvedValue(undefined),
      recordFailedAttempt,
      clearFailedAttempts,
      savePendingMfaSecret: vi.fn(),
      confirmMfa: vi.fn(),
      recordMfaStep: vi.fn(),
    };

    const hasher: PasswordHasherPort = {
      hash: vi.fn().mockResolvedValue('new-hash'),
      verify,
      needsRehash: vi.fn().mockReturnValue(false),
      burnTime,
    };

    const tokens: TokenIssuerPort = {
      issueAccessToken: vi.fn().mockResolvedValue('access-token'),
    };
    const refreshTokens: RefreshTokenPort = {
      issueForNewSession: vi.fn().mockResolvedValue({
        token: 'refresh-token',
        familyId: 'fam-1',
        expiresAt: new Date('2026-12-31'),
      }),
      rotate: vi.fn(),
      revokeFamily: vi.fn(),
      revokeAllForUser: vi.fn(),
    };
    const totp: TotpPort = { enroll: vi.fn(), verify: vi.fn() };

    const logger = {
      setContext: vi.fn(),
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PinoLogger;

    service = new AuthService(
      users,
      hasher,
      tokens,
      refreshTokens,
      totp,
      logger,
    );
  });

  /** The rejection code an anonymous caller receives. */
  async function codeFor(user: AuthUser | null, password = 'lo que sea') {
    findByEmail.mockResolvedValue(user);
    try {
      await service.signIn('medico@clinica.ec', password);
      return 'NO_ERROR';
    } catch (error) {
      return (error as InvalidCredentialsError).code;
    }
  }

  it('answers the same for an unknown email and a wrong password', async () => {
    expect(await codeFor(null)).toBe('INVALID_CREDENTIALS');
    expect(await codeFor(buildUser())).toBe('INVALID_CREDENTIALS');
  });

  it('answers the same for a LOCKED account', async () => {
    // The attack this closes is not passive. Five wrong guesses lock any
    // account, so answering ACCOUNT_LOCKED let an attacker CREATE the state
    // that confirms the address belongs to somebody who works here — and shut
    // that person out at the same time.
    const locked = buildUser({
      lockedUntil: new Date(Date.now() + 15 * 60_000),
    });

    expect(await codeFor(locked, CORRECT)).toBe('INVALID_CREDENTIALS');
    expect(await codeFor(locked)).toBe('INVALID_CREDENTIALS');
  });

  it('answers the same for an INACTIVE account', async () => {
    const inactive = buildUser({ active: false });

    expect(await codeFor(inactive, CORRECT)).toBe('INVALID_CREDENTIALS');
  });

  it('spends the same work on every rejection', async () => {
    // A unified response body is not enough on its own: returning early
    // without hashing left a ~100 ms gap that answers the same question.
    for (const user of [
      null,
      buildUser({ active: false }),
      buildUser({ lockedUntil: new Date(Date.now() + 60_000) }),
    ]) {
      burnTime.mockClear();
      verify.mockClear();

      await codeFor(user).catch(() => undefined);

      const worked = burnTime.mock.calls.length + verify.mock.calls.length;
      expect(worked).toBeGreaterThan(0);
    }
  });

  it('does NOT verify the password of a locked account', async () => {
    // Hashing on a locked account would let a flood against one address spend
    // Argon2 CPU at will.
    await codeFor(buildUser({ lockedUntil: new Date(Date.now() + 60_000) }));

    expect(verify).not.toHaveBeenCalled();
    expect(burnTime).toHaveBeenCalled();
  });

  it('records the real reason where only staff can read it', async () => {
    // The person genuinely locked out learns it from an administrator, not
    // from an endpoint that answers anybody who can type their address.
    warn.mockClear();

    await codeFor(buildUser({ active: false }), CORRECT);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'ACCOUNT_INACTIVE' }),
      expect.any(String),
    );
  });

  it('still signs in a healthy account', async () => {
    // The whole point of the above is to reject without saying why. It must
    // not have broken the case that should succeed.
    findByEmail.mockResolvedValue(buildUser());

    const session = await service.signIn('medico@clinica.ec', CORRECT);

    expect(session).toMatchObject({ accessToken: 'access-token' });
    expect(clearFailedAttempts).toHaveBeenCalledWith('user-1');
  });

  it('counts a failed attempt only when the password was wrong', async () => {
    await codeFor(buildUser());
    expect(recordFailedAttempt).toHaveBeenCalled();

    recordFailedAttempt.mockClear();
    await codeFor(buildUser({ lockedUntil: new Date(Date.now() + 60_000) }));
    expect(recordFailedAttempt).not.toHaveBeenCalled();
  });
});
