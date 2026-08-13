import { PinoLogger } from 'nestjs-pino';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { AuthService } from './auth.service';
import { InvalidCredentialsError } from '../domain/auth.errors';
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
  let registerFailure: Mock<AuthUserRepositoryPort['registerFailure']>;
  let applyLock: Mock<AuthUserRepositoryPort['applyLock']>;
  let clearFailedAttempts: Mock<AuthUserRepositoryPort['clearFailedAttempts']>;
  let verify: Mock<PasswordHasherPort['verify']>;
  let burnTime: Mock<PasswordHasherPort['burnTime']>;
  let warn: Mock<(context: object, message: string) => void>;
  let service: AuthService;

  beforeEach(() => {
    findByEmail = vi
      .fn<AuthUserRepositoryPort['findByEmail']>()
      .mockResolvedValue(null);
    // Returns the NEW count, the way the database does.
    registerFailure = vi
      .fn<AuthUserRepositoryPort['registerFailure']>()
      .mockResolvedValue(1);
    applyLock = vi
      .fn<AuthUserRepositoryPort['applyLock']>()
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
      registerFailure,
      applyLock,
      clearFailedAttempts,
      savePendingMfaSecret: vi.fn(),
      confirmMfa: vi.fn(),
      recordMfaStep: vi.fn(),
      rotateCredentials: vi.fn().mockResolvedValue(undefined),
      findActiveGrants: vi.fn().mockResolvedValue([]),
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

  it('AU-002 answers the same for an unknown email and a wrong password', async () => {
    expect(await codeFor(null)).toBe('INVALID_CREDENTIALS');
    expect(await codeFor(buildUser())).toBe('INVALID_CREDENTIALS');
  });

  it('AU-002 answers the same for a LOCKED account', async () => {
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

  it('AU-002 answers the same for an INACTIVE account', async () => {
    const inactive = buildUser({ active: false });

    expect(await codeFor(inactive, CORRECT)).toBe('INVALID_CREDENTIALS');
  });

  it('AU-002 spends the same work on every rejection', async () => {
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

  it('AU-003 does NOT verify the password of a locked account', async () => {
    // Hashing on a locked account would let a flood against one address spend
    // Argon2 CPU at will.
    await codeFor(buildUser({ lockedUntil: new Date(Date.now() + 60_000) }));

    expect(verify).not.toHaveBeenCalled();
    expect(burnTime).toHaveBeenCalled();
  });

  it('AU-002 records the real reason where only staff can read it', async () => {
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

  it('AU-003 counts a failed attempt only when the password was wrong', async () => {
    await codeFor(buildUser());
    expect(registerFailure).toHaveBeenCalled();

    registerFailure.mockClear();
    await codeFor(buildUser({ lockedUntil: new Date(Date.now() + 60_000) }));
    expect(registerFailure).not.toHaveBeenCalled();
  });

  /**
   * AU-003 — «bloquear la cuenta tras un número de intentos fallidos y
   * registrar el bloqueo».
   *
   * NADA DE ESTO ESTABA PROBADO. `applyLock` existía como doble desde el
   * primer día y ninguna aserción lo miraba, así que el umbral, la espera
   * creciente, su techo y el registro del bloqueo podían romperse los cuatro
   * sin que fallara nada. Es la mitad del requisito que de verdad frena un
   * ataque por fuerza bruta: la otra —no decir que la cuenta está
   * bloqueada— sí lo estaba, y sin esta no sirve de mucho.
   *
   * EL RELOJ SE FIJA. El instante del bloqueo se calcula desde `Date.now()`,
   * así que sin fijarlo la aserción sería una ventana de tolerancia — y una
   * ventana es justo lo que deja pasar un error de factor.
   *
   * Los números van escritos, no importados: `MAX_FAILED_ATTEMPTS` y las dos
   * constantes de espera son privadas del servicio, y aunque se exportaran
   * afirmar `constante === constante` no comprueba nada. Cinco intentos y un
   * minuto que se dobla hasta quince son una decisión de seguridad; cambiarla
   * debe costar tocar esta prueba y leer por qué.
   */
  describe('AU-003 el bloqueo tras intentos fallidos', () => {
    const AHORA = new Date('2026-08-13T14:00:00Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(AHORA);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Segundos de bloqueo aplicados, o `null` si no se bloqueó. */
    async function lockAfter(failures: number): Promise<number | null> {
      registerFailure.mockResolvedValue(failures);
      applyLock.mockClear();

      await codeFor(buildUser());

      const call = applyLock.mock.calls[0];
      if (!call) return null;
      return (call[1].getTime() - AHORA.getTime()) / 1000;
    }

    it('AU-003 no bloquea antes del quinto intento', async () => {
      expect(await lockAfter(4)).toBeNull();
    });

    it('AU-003 bloquea un minuto al quinto intento fallido', async () => {
      expect(await lockAfter(5)).toBe(60);
    });

    it('AU-003 dobla la espera en cada intento posterior', async () => {
      // Que crezca es lo que convierte un ataque de minutos en uno de días.
      // Una espera fija de un minuto permite 1 440 intentos diarios contra
      // una misma cuenta, que sobre una contraseña débil basta.
      expect(await lockAfter(6)).toBe(120);
      expect(await lockAfter(7)).toBe(240);
      expect(await lockAfter(8)).toBe(480);
    });

    it('AU-003 topa la espera en quince minutos y no sigue creciendo', async () => {
      // El techo existe para que un atacante no pueda dejar fuera para
      // siempre a una persona real: pasadas las horas la cuenta vuelve sola,
      // sin que nadie tenga que llamar a un administrador de madrugada.
      expect(await lockAfter(9)).toBe(900);
      expect(await lockAfter(20)).toBe(900);
    });

    it('AU-003 deja constancia del bloqueo donde solo lo lee el personal', async () => {
      warn.mockClear();
      await lockAfter(5);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCOUNT_LOCKED', count: 5 }),
        expect.any(String),
      );
    });
  });
});
