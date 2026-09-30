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

import { AccountLockout } from './account-lockout';
import { AuthService } from './auth.service';
import { SecondFactorVerifier } from './second-factor-verifier';
import { BACKUP_CODE_COUNT } from '../domain/backup-code';
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
    mfaPendingSecretEncrypted: null,
    mfaEnabledAt: null,
    mfaLastStep: null,
    failedAttempts: 0,
    lockedUntil: null,
    sessionEpoch: 0,
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
  let issueForNewSession: Mock<RefreshTokenPort['issueForNewSession']>;
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
      savePendingMfaChange: vi.fn(),
      recordMfaStep: vi.fn(),
      confirmMfaWithBackupCodes: vi.fn().mockResolvedValue(true),
      replaceMfaSecretWithBackupCodes: vi.fn().mockResolvedValue(true),
      findLiveBackupCodes: vi.fn().mockResolvedValue([]),
      consumeBackupCode: vi.fn().mockResolvedValue(false),
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
    issueForNewSession = vi
      .fn<RefreshTokenPort['issueForNewSession']>()
      .mockResolvedValue({
        token: 'refresh-token',
        familyId: 'fam-1',
        expiresAt: new Date('2026-12-31'),
      });
    const refreshTokens: RefreshTokenPort = {
      issueForNewSession,
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

    // The two collaborators are REAL, wired to the same doubles. Replacing
    // them with stubs would leave the lockout and the second factor untested
    // from here, which is where their behaviour is actually specified.
    const lockout = new AccountLockout(users, logger);

    service = new AuthService(
      users,
      hasher,
      tokens,
      refreshTokens,
      lockout,
      new SecondFactorVerifier(users, hasher, totp, lockout, logger),
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

  it('AU-041 emite la sesión con la época leída junto a las credenciales', async () => {
    findByEmail.mockResolvedValue(buildUser({ sessionEpoch: 3 }));

    await service.signIn('medico@clinica.ec', CORRECT);

    expect(issueForNewSession).toHaveBeenCalledWith('user-1', 3, {});
  });

  it('AU-041 si se cerraron todas las sesiones mientras tanto, responde como AU-002 y lo registra', async () => {
    // The adapter found the epoch moved: a password change, a deactivation, a
    // reset or a redeemed invitation landed between reading and issuing.
    issueForNewSession.mockResolvedValue(null);
    warn.mockClear();

    expect(await codeFor(buildUser(), CORRECT)).toBe('INVALID_CREDENTIALS');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'SESSIONS_CLOSED_DURING_SIGN_IN',
      }),
      expect.any(String),
    );
  });

  it('la sesión dice que esta cuenta NO tiene segundo factor', async () => {
    /**
     * WHY THE SESSION CARRIES IT. Whether YOUR OWN account has a second
     * factor is your own data and needs no permission, and until now the only
     * way to find out was `GET /auth/users` — administration, `user:read`
     * over the whole payroll. The screen that offers «matricular» and
     * «cambiar de dispositivo» could not tell which of the two would work, so
     * it offered both and one of them was guaranteed to fail.
     */
    findByEmail.mockResolvedValue(buildUser());

    const session = await service.signIn('medico@clinica.ec', CORRECT);

    expect(session).toMatchObject({ mfaEnabled: false });
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

/**
 * AU-005 — «matricular un segundo factor TOTP CON CÓDIGOS DE RESPALDO».
 *
 * The half that exists for the day the phone does not. What is asserted here
 * is not only that a backup code works: it is that using one is not a SOFTER
 * path than the TOTP. A backup code that answered differently, or that cost no
 * failed attempt, would make the recovery route the one an attacker picks.
 */
describe('AU-005 el segundo factor acepta un código de respaldo', () => {
  const LIVE_CODE = 'ABCDE-FGHJK';
  const CANONICAL = 'ABCDEFGHJK';

  /**
   * The refusal the TOTP verifier produces, kept as ONE instance.
   *
   * Asserting the exact same object is what proves a wrong backup code and a
   * wrong TOTP are indistinguishable — two different instances of two classes
   * that happen to share a code would drift apart the first time either
   * message is edited.
   *
   * Declared here rather than imported from `totp.service.ts`: the application
   * layer must not reach into infrastructure, and `pnpm arch:check` counts a
   * spec in this folder as part of it.
   */
  const totpRefusal = new Error('TOTP code is invalid or already used');

  let findById: Mock<AuthUserRepositoryPort['findById']>;
  let findLiveBackupCodes: Mock<AuthUserRepositoryPort['findLiveBackupCodes']>;
  let consumeBackupCode: Mock<AuthUserRepositoryPort['consumeBackupCode']>;
  let registerFailure: Mock<AuthUserRepositoryPort['registerFailure']>;
  let applyLock: Mock<AuthUserRepositoryPort['applyLock']>;
  let clearFailedAttempts: Mock<AuthUserRepositoryPort['clearFailedAttempts']>;
  let recordMfaStep: Mock<AuthUserRepositoryPort['recordMfaStep']>;
  let verifyHash: Mock<PasswordHasherPort['verify']>;
  let burnTime: Mock<PasswordHasherPort['burnTime']>;
  let totpVerify: Mock<TotpPort['verify']>;
  let service: AuthService;

  const enrolled = buildUser({
    mfaSecretEncrypted: 'encrypted-secret',
    mfaEnabledAt: new Date('2026-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    findById = vi
      .fn<AuthUserRepositoryPort['findById']>()
      .mockResolvedValue(enrolled);
    findLiveBackupCodes = vi
      .fn<AuthUserRepositoryPort['findLiveBackupCodes']>()
      .mockResolvedValue([
        { id: 'code-7', codeHash: `argon2-of:${CANONICAL}` },
      ]);
    consumeBackupCode = vi
      .fn<AuthUserRepositoryPort['consumeBackupCode']>()
      .mockResolvedValue(true);
    registerFailure = vi
      .fn<AuthUserRepositoryPort['registerFailure']>()
      .mockResolvedValue(1);
    applyLock = vi
      .fn<AuthUserRepositoryPort['applyLock']>()
      .mockResolvedValue(undefined);
    clearFailedAttempts = vi
      .fn<AuthUserRepositoryPort['clearFailedAttempts']>()
      .mockResolvedValue(undefined);
    recordMfaStep = vi
      .fn<AuthUserRepositoryPort['recordMfaStep']>()
      .mockResolvedValue(undefined);
    // Stands in for Argon2 without paying for it: the double answers true only
    // for the hash of the very code presented.
    verifyHash = vi.fn<PasswordHasherPort['verify']>((hash, plain) =>
      Promise.resolve(hash === `argon2-of:${plain}`),
    );
    burnTime = vi
      .fn<PasswordHasherPort['burnTime']>()
      .mockResolvedValue(undefined);
    totpVerify = vi.fn<TotpPort['verify']>(() => {
      throw totpRefusal;
    });

    const users = {
      findById,
      findLiveBackupCodes,
      consumeBackupCode,
      registerFailure,
      applyLock,
      clearFailedAttempts,
      recordMfaStep,
      findActiveGrants: vi.fn().mockResolvedValue([]),
    } as unknown as AuthUserRepositoryPort;

    const hasher = {
      hash: vi.fn(),
      verify: verifyHash,
      needsRehash: vi.fn().mockReturnValue(false),
      burnTime,
    } as unknown as PasswordHasherPort;

    const tokens: TokenIssuerPort = {
      issueAccessToken: vi.fn().mockResolvedValue('access-token'),
    };
    const refreshTokens = {
      issueForNewSession: vi.fn().mockResolvedValue({
        token: 'refresh-token',
        familyId: 'fam-1',
        expiresAt: new Date('2026-12-31'),
      }),
    } as unknown as RefreshTokenPort;

    const logger = {
      setContext: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    } as unknown as PinoLogger;
    const totp: TotpPort = { enroll: vi.fn(), verify: totpVerify };
    const lockout = new AccountLockout(users, logger);

    service = new AuthService(
      users,
      hasher,
      tokens,
      refreshTokens,
      lockout,
      new SecondFactorVerifier(users, hasher, totp, lockout, logger),
      logger,
    );
  });

  it('AU-005 completa el segundo factor con un código de respaldo cuando el TOTP no sirve', async () => {
    // Exactly the situation the requirement exists for: the phone is gone, so
    // there is no authenticator to read a code from.
    const session = await service.verifyMfa('user-1', 0, LIVE_CODE);

    expect(session.accessToken).toBe('access-token');
    expect(consumeBackupCode).toHaveBeenCalledWith('code-7');
    // Using a backup code is not a failed sign-in: the counter is cleared like
    // any other successful second factor.
    expect(clearFailedAttempts).toHaveBeenCalledWith('user-1');
    expect(recordMfaStep).not.toHaveBeenCalled();
  });

  it('AU-041 una cuenta desactivada no completa el segundo factor, ni con el código bueno', async () => {
    findById.mockResolvedValue({ ...enrolled, active: false });

    await expect(
      service.verifyMfa('user-1', 0, LIVE_CODE),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(totpVerify).not.toHaveBeenCalled();
  });

  it('AU-041 un desafío sin época se rechaza igual: no hay con qué comparar', async () => {
    await expect(
      service.verifyMfa('user-1', undefined, LIVE_CODE),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(totpVerify).not.toHaveBeenCalled();
  });

  it('la sesión dice que esta cuenta SÍ tiene segundo factor', async () => {
    // El otro estado del mismo campo. Con los dos escritos, un `mfaEnabled`
    // constante —el error fácil— no puede pasar las dos pruebas.
    const session = await service.verifyMfa('user-1', 0, LIVE_CODE);

    expect(session.mfaEnabled).toBe(true);
  });

  it('AU-005 es de un solo uso: el código gastado ya no está entre los vivos', async () => {
    findLiveBackupCodes.mockResolvedValue([]);

    await expect(service.verifyMfa('user-1', 0, LIVE_CODE)).rejects.toBe(
      totpRefusal,
    );
    expect(consumeBackupCode).not.toHaveBeenCalled();
  });

  it('AU-005 quien pierde la carrera por el mismo código recibe el mismo rechazo', async () => {
    // The winner is decided in the database by a conditional update; losing it
    // is indistinguishable from having typed a code that was already spent,
    // and it answers accordingly.
    consumeBackupCode.mockResolvedValue(false);

    await expect(service.verifyMfa('user-1', 0, LIVE_CODE)).rejects.toBe(
      totpRefusal,
    );
  });

  it('AU-005 un código de respaldo incorrecto responde EXACTAMENTE igual que un TOTP incorrecto', async () => {
    // Two different answers would say whether the account has live backup
    // codes, which is a fact about somebody who works here.
    await expect(service.verifyMfa('user-1', 0, 'ZZZZZ-ZZZZZ')).rejects.toBe(
      totpRefusal,
    );
    await expect(service.verifyMfa('user-1', 0, '123456')).rejects.toBe(
      totpRefusal,
    );
  });

  it('AU-005 un código de respaldo fallido cuenta para el mismo bloqueo que el TOTP', async () => {
    // Without this the backup code is the weak path: unlimited guesses against
    // 50 bits, while the six-digit TOTP locks after three.
    registerFailure.mockResolvedValue(3);

    await expect(service.verifyMfa('user-1', 0, 'ZZZZZ-ZZZZZ')).rejects.toBe(
      totpRefusal,
    );

    expect(registerFailure).toHaveBeenCalledWith('user-1');
    expect(applyLock).toHaveBeenCalledWith('user-1', expect.any(Date));
  });

  it('AU-005 no gasta Argon2 con un código que ni siquiera tiene forma de respaldo', async () => {
    // Verifying costs one Argon2 per live code, so a mistyped TOTP must not
    // reach the loop. The decision is made on the SHAPE OF THE INPUT, which is
    // the caller's own doing and reveals nothing about the account.
    await expect(service.verifyMfa('user-1', 0, '123456')).rejects.toBe(
      totpRefusal,
    );

    expect(findLiveBackupCodes).not.toHaveBeenCalled();
    expect(verifyHash).not.toHaveBeenCalled();
    expect(burnTime).not.toHaveBeenCalled();
  });

  it('AU-005 gasta el mismo trabajo tenga la cuenta diez códigos vivos o ninguno', async () => {
    /**
     * THE TIMING ORACLE THIS CLOSES. The response is already identical, but
     * the WORK was not: an account with no live codes answered after zero
     * Argon2 verifications and one with ten after ten — half a second apart,
     * which is a perfectly readable answer to "does this person have backup
     * codes". The failing path pads with `burnTime` up to the batch size.
     */
    const workFor = async (live: number): Promise<number> => {
      verifyHash.mockClear();
      burnTime.mockClear();
      findLiveBackupCodes.mockResolvedValue(
        Array.from({ length: live }, (_, index) => ({
          id: `code-${index}`,
          codeHash: `argon2-of:no-es-este-${index}`,
        })),
      );

      await service
        .verifyMfa('user-1', 0, 'ZZZZZ-ZZZZZ')
        .catch(() => undefined);
      return verifyHash.mock.calls.length + burnTime.mock.calls.length;
    };

    const withNone = await workFor(0);
    expect(withNone).toBe(BACKUP_CODE_COUNT);
    expect(await workFor(4)).toBe(withNone);
    expect(await workFor(BACKUP_CODE_COUNT)).toBe(withNone);
  });

  it('AU-005 gasta el mismo trabajo aunque la cuenta tenga MÁS códigos vivos que un lote', async () => {
    /**
     * EL RELLENO NO PUEDE FIARSE DE QUE NADIE ESCRIBA DE MÁS.
     *
     * Nada en la base acota cuántas filas vivas puede tener una cuenta: la
     * tabla `backup_code` tiene clave primaria, clave ajena y un índice sobre
     * `(user_id, used_at)`, y nada más. Si el bucle da por hecho el tamaño del
     * lote, una cuenta con veinte filas vivas cuesta VEINTE verificaciones
     * donde las demás cuestan diez —el doble de latencia— y el relleno no
     * llega a ejecutarse ni una vez: justo el oráculo por tiempo que el
     * relleno existe para cerrar (AU-002).
     *
     * Se cuentan llamadas sobre los dobles y no milisegundos: medir tiempo
     * aquí sería medir la máquina.
     */
    const workFor = async (live: number): Promise<number> => {
      verifyHash.mockClear();
      burnTime.mockClear();
      findLiveBackupCodes.mockResolvedValue(
        Array.from({ length: live }, (_, index) => ({
          id: `code-${index}`,
          codeHash: `argon2-of:no-es-este-${index}`,
        })),
      );

      await service
        .verifyMfa('user-1', 0, 'ZZZZZ-ZZZZZ')
        .catch(() => undefined);
      return verifyHash.mock.calls.length + burnTime.mock.calls.length;
    };

    const withNone = await workFor(0);
    expect(withNone).toBe(BACKUP_CODE_COUNT);
    expect(await workFor(BACKUP_CODE_COUNT + 1)).toBe(withNone);
    expect(await workFor(BACKUP_CODE_COUNT * 2)).toBe(withNone);
  });
});
