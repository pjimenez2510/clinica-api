import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKUP_CODE_COUNT, normalizeBackupCode } from '../domain/backup-code';
import {
  MfaAlreadyEnrolledError,
  MfaChangeNotStartedError,
  MfaNotEnrolledError,
  SessionUserMissingError,
} from '../domain/auth.errors';
import { MfaEnrolmentService } from './mfa-enrolment.service';
import type { SecondFactorVerifier } from './second-factor-verifier';
import type {
  AuthUser,
  AuthUserRepositoryPort,
  PasswordHasherPort,
} from './ports';

const user = (overrides: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 'user-1',
    email: 'medico@clinica.ec',
    mfaEnabledAt: null,
    mfaSecretEncrypted: null,
    mfaPendingSecretEncrypted: null,
    ...overrides,
  }) as AuthUser;

/** An account with a WORKING second factor: the starting point of AU-037. */
const enrolledUser = (overrides: Partial<AuthUser> = {}): AuthUser =>
  user({
    mfaSecretEncrypted: 'encrypted-old-secret',
    mfaEnabledAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

describe('MfaEnrolmentService', () => {
  const findById = vi.fn();
  const savePendingMfaSecret = vi.fn();
  const savePendingMfaChange = vi.fn();
  const confirmMfaWithBackupCodes = vi.fn();
  const replaceMfaSecretWithBackupCodes = vi.fn();
  const enroll = vi.fn();
  const verify = vi.fn();
  const hash = vi.fn();
  const verifySecondFactor = vi.fn();
  let service: MfaEnrolmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    replaceMfaSecretWithBackupCodes.mockResolvedValue(true);
    verifySecondFactor.mockResolvedValue({ kind: 'totp', usedStep: 7n });
    // Argon2 is not run here: the point of the port is that the service can be
    // tested without spending ~50 ms per code. The prefix is what lets a test
    // assert that what gets stored is the HASH and never the code itself.
    hash.mockImplementation((plain: string) =>
      Promise.resolve(`argon2-of:${plain}`),
    );
    enroll.mockReturnValue({
      secret: 'plain-secret',
      encrypted: 'encrypted-secret',
      uri: 'otpauth://totp/x',
    });
    verify.mockReturnValue(42);
    // The database's answer to "was it me that confirmed?". `false` is a real
    // outcome, not a fault: see the race below.
    confirmMfaWithBackupCodes.mockResolvedValue(true);

    service = new MfaEnrolmentService(
      {
        findById,
        savePendingMfaSecret,
        savePendingMfaChange,
        confirmMfaWithBackupCodes,
        replaceMfaSecretWithBackupCodes,
      } as unknown as AuthUserRepositoryPort,
      { hash } as unknown as PasswordHasherPort,
      { enroll, verify },
      {
        verify: verifySecondFactor,
      } as unknown as SecondFactorVerifier,
      { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
    );
  });

  it('stores the pending secret server-side and returns the plaintext exactly once', async () => {
    findById.mockResolvedValue(user());

    const result = await service.enroll('user-1');

    expect(savePendingMfaSecret).toHaveBeenCalledWith(
      'user-1',
      'encrypted-secret',
    );
    expect(result).toEqual({ secret: 'plain-secret', uri: 'otpauth://totp/x' });
  });

  it('refuses to enrol a user who already has a second factor', async () => {
    findById.mockResolvedValue(
      user({ mfaEnabledAt: new Date('2026-01-01T00:00:00Z') }),
    );

    await expect(service.enroll('user-1')).rejects.toBeInstanceOf(
      MfaAlreadyEnrolledError,
    );
    expect(savePendingMfaSecret).not.toHaveBeenCalled();
  });

  it('confirms only when a pending secret exists and records the used step', async () => {
    findById.mockResolvedValue(
      user({ mfaSecretEncrypted: 'encrypted-secret' }),
    );

    await service.confirm('user-1', '123456');

    // The step is recorded so the SAME code cannot both confirm the enrolment
    // and pass the first verification: replay inside the 30-second window.
    expect(verify).toHaveBeenCalledWith(
      'encrypted-secret',
      '123456',
      'medico@clinica.ec',
      null,
    );
    expect(confirmMfaWithBackupCodes).toHaveBeenCalledWith(
      'user-1',
      42,
      expect.any(Array),
    );
  });

  it('refuses to confirm without a pending secret, and refuses twice', async () => {
    findById.mockResolvedValue(user());
    await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
      MfaNotEnrolledError,
    );

    findById.mockResolvedValue(
      user({
        mfaSecretEncrypted: 'encrypted-secret',
        mfaEnabledAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
      MfaAlreadyEnrolledError,
    );
    expect(confirmMfaWithBackupCodes).not.toHaveBeenCalled();
  });

  it('answers the same for an unknown user as for a missing session', async () => {
    findById.mockResolvedValue(null);

    await expect(service.enroll('ghost')).rejects.toBeInstanceOf(
      SessionUserMissingError,
    );
  });

  /**
   * AU-005 — «matricular un segundo factor TOTP CON CÓDIGOS DE RESPALDO».
   *
   * Confirming enrolment is the only moment the batch can be handed over: the
   * plaintext is never stored, so there is nowhere to read it from afterwards.
   * If this half is missing, whoever loses their phone has no way back in
   * except an administrator editing the database by hand.
   */
  describe('AU-005 códigos de respaldo al confirmar', () => {
    it('AU-005 entrega el lote de códigos una sola vez, al confirmar', async () => {
      findById.mockResolvedValue(
        user({ mfaSecretEncrypted: 'encrypted-secret' }),
      );

      const { backupCodes } = await service.confirm('user-1', '123456');

      expect(backupCodes).toHaveLength(BACKUP_CODE_COUNT);
      expect(new Set(backupCodes).size).toBe(BACKUP_CODE_COUNT);
      for (const code of backupCodes) {
        expect(normalizeBackupCode(code)).not.toBeNull();
      }
    });

    it('AU-005 guarda solo el hash Argon2 del código, nunca el código', async () => {
      // A backup code is a credential typed by a person: a database dump that
      // contains it is a set of working second factors.
      findById.mockResolvedValue(
        user({ mfaSecretEncrypted: 'encrypted-secret' }),
      );

      const { backupCodes } = await service.confirm('user-1', '123456');

      expect(hash).toHaveBeenCalledTimes(BACKUP_CODE_COUNT);
      const stored = confirmMfaWithBackupCodes.mock.calls[0]?.[2] as string[];
      expect(stored).toHaveLength(BACKUP_CODE_COUNT);

      for (const [index, code] of backupCodes.entries()) {
        // Hashed in its CANONICAL form — without the hyphen it is printed
        // with — because that is what a presented code normalises to.
        expect(hash).toHaveBeenCalledWith(normalizeBackupCode(code));
        expect(stored[index]).toBe(`argon2-of:${normalizeBackupCode(code)}`);
        expect(stored).not.toContain(code);
      }
    });

    it('AU-005 habilita el factor y guarda el lote en UNA sola operación', async () => {
      /**
       * NO SON DOS ESCRITURAS QUE SE PUEDAN SEPARAR, y por eso no se pide en
       * dos llamadas.
       *
       * Habilitar el segundo factor y fallar después al guardar los códigos
       * deja una cuenta con factor y sin forma de recuperarla, sin ruta de
       * regeneración: exactamente el bloqueo que AU-005 existe para evitar. Al
       * revés deja códigos colgando de una cuenta cuyo factor nunca se
       * habilitó, que es solo inútil. Ninguno de los dos estados debe poder
       * quedar escrito, así que el adaptador confirma los dos o ninguno — y
       * eso solo se puede exigir desde aquí pidiéndolo como una sola cosa.
       */
      findById.mockResolvedValue(
        user({ mfaSecretEncrypted: 'encrypted-secret' }),
      );

      const { backupCodes } = await service.confirm('user-1', '123456');

      expect(confirmMfaWithBackupCodes).toHaveBeenCalledTimes(1);
      const [userId, usedStep, hashes] = confirmMfaWithBackupCodes.mock
        .calls[0] as [string, bigint, string[]];
      expect(userId).toBe('user-1');
      expect(usedStep).toBe(42);
      // El paso TOTP y el lote entregado viajan juntos: son el mismo hecho.
      expect(hashes).toEqual(
        backupCodes.map((code) => `argon2-of:${normalizeBackupCode(code)}`),
      );
    });

    it('AU-005 quien pierde la carrera de la confirmación no recibe lote alguno', async () => {
      /**
       * EL DOBLE ENVÍO DEL FORMULARIO. Las dos peticiones llevan el MISMO
       * código TOTP y las dos lo superan —confirmar pasa `null` como último
       * paso usado, a propósito—, así que las dos llegan hasta aquí con un
       * lote generado. Quién habilitó de verdad el factor lo decide la base en
       * la misma sentencia que escribe, y quien pierde NO puede devolver sus
       * diez códigos: nunca se guardaron, y entregarlos dejaría a la persona
       * apuntando en un papel una lista que no abre nada.
       *
       * Pierde igual que quien confirma una cuenta ya matriculada, porque eso
       * es lo que acaba de pasar.
       */
      findById.mockResolvedValue(
        user({ mfaSecretEncrypted: 'encrypted-secret' }),
      );
      confirmMfaWithBackupCodes.mockResolvedValue(false);

      await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
        MfaAlreadyEnrolledError,
      );
    });

    it('AU-005 no genera códigos si la confirmación se rechaza', async () => {
      findById.mockResolvedValue(user());

      await expect(service.confirm('user-1', '123456')).rejects.toBeInstanceOf(
        MfaNotEnrolledError,
      );

      expect(confirmMfaWithBackupCodes).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    });
  });

  /**
   * AU-037 — cambiar el segundo factor probando el ACTUAL.
   *
   * Lo que estas pruebas vigilan, y que no es evidente al leer el servicio:
   * empezar una rematrícula NO PUEDE tocar el factor que está funcionando. Si
   * lo tocara, cerrar la pestaña a la mitad dejaría a la persona sin ningún
   * segundo factor y sin sesión con la que arreglarlo.
   */
  describe('AU-037 cambio del segundo factor con prueba del actual', () => {
    it('AU-037 empezar el cambio NO retira el secreto actual ni el lote vivo', async () => {
      // LA INVARIANTE DE LA ENTREGA. El secreto nuevo se guarda APARTE; el
      // que está en uso sigue exactamente donde estaba hasta que se confirme.
      findById.mockResolvedValue(enrolledUser());

      await service.startChange('user-1', '123456');

      expect(savePendingMfaChange).toHaveBeenCalledWith(
        'user-1',
        'encrypted-secret',
      );
      // `savePendingMfaSecret` es la primera matrícula: pisa
      // `mfaSecretEncrypted` y borra `mfaEnabledAt`. Aquí sería el fallo.
      expect(savePendingMfaSecret).not.toHaveBeenCalled();
      expect(replaceMfaSecretWithBackupCodes).not.toHaveBeenCalled();
    });

    it('AU-037 devuelve el secreto nuevo una sola vez, para el QR', async () => {
      findById.mockResolvedValue(enrolledUser());

      const result = await service.startChange('user-1', '123456');

      expect(result).toEqual({
        secret: 'plain-secret',
        uri: 'otpauth://totp/x',
      });
    });

    it('AU-037 comprueba la prueba contra el factor ACTUAL antes de generar nada', async () => {
      const current = enrolledUser();
      findById.mockResolvedValue(current);

      await service.startChange('user-1', 'ABCDE-FGHJK');

      // El usuario entero, no sólo su id: quien verifica necesita el secreto
      // en uso, el último paso consumido y el bloqueo de la cuenta.
      expect(verifySecondFactor).toHaveBeenCalledWith(current, 'ABCDE-FGHJK');
    });

    it('AU-037 una prueba inválida no deja rematrícula empezada', async () => {
      // Y responde con el MISMO error que la verificación del segundo factor:
      // el servicio no lo traduce, así que no puede decir nada distinto.
      const refusal = new Error('el mismo rechazo que un TOTP incorrecto');
      findById.mockResolvedValue(enrolledUser());
      verifySecondFactor.mockRejectedValue(refusal);

      await expect(service.startChange('user-1', '000000')).rejects.toBe(
        refusal,
      );

      expect(enroll).not.toHaveBeenCalled();
      expect(savePendingMfaChange).not.toHaveBeenCalled();
    });

    it('AU-037 rechaza cambiar un segundo factor que no está confirmado', async () => {
      // Sin factor confirmado no hay nada que probar ni nada que sustituir:
      // ese camino es la matrícula normal (AU-005).
      findById.mockResolvedValue(user({ mfaSecretEncrypted: 'a-medias' }));

      await expect(
        service.startChange('user-1', '123456'),
      ).rejects.toBeInstanceOf(MfaNotEnrolledError);

      expect(verifySecondFactor).not.toHaveBeenCalled();
      expect(savePendingMfaChange).not.toHaveBeenCalled();
    });

    it('AU-037 confirma contra el secreto PENDIENTE y sin último paso', async () => {
      findById.mockResolvedValue(
        enrolledUser({
          mfaPendingSecretEncrypted: 'encrypted-new-secret',
          mfaLastStep: 999n,
        }),
      );

      await service.confirmChange('user-1', '123456');

      /**
       * `null` Y NO `mfaLastStep`, y el motivo es que el paso pertenece al
       * SECRETO, no a la cuenta. El que hay guardado es el que consumió la
       * prueba del factor viejo hace un instante, así que compararlo con el
       * del secreto nuevo —que es el mismo instante— rechazaría un código
       * legítimo. Quien impide la doble confirmación es la reclamación
       * atómica de abajo, no este parámetro.
       */
      expect(verify).toHaveBeenCalledWith(
        'encrypted-new-secret',
        '123456',
        'medico@clinica.ec',
        null,
      );
    });

    it('AU-037 sustituye el secreto y emite el lote nuevo en UNA sola operación', async () => {
      findById.mockResolvedValue(
        enrolledUser({ mfaPendingSecretEncrypted: 'encrypted-new-secret' }),
      );

      const { backupCodes } = await service.confirmChange('user-1', '123456');

      expect(backupCodes).toHaveLength(BACKUP_CODE_COUNT);
      expect(replaceMfaSecretWithBackupCodes).toHaveBeenCalledTimes(1);

      const [userId, pending, usedStep, hashes] =
        replaceMfaSecretWithBackupCodes.mock.calls[0] as [
          string,
          string,
          bigint,
          string[],
        ];
      expect(userId).toBe('user-1');
      // El secreto que se reclama es EXACTAMENTE el que se acaba de verificar.
      expect(pending).toBe('encrypted-new-secret');
      expect(usedStep).toBe(42);
      expect(hashes).toEqual(
        backupCodes.map((code) => `argon2-of:${normalizeBackupCode(code)}`),
      );
      // Los códigos viajan hasheados: el lote en claro sólo existe en la
      // respuesta.
      expect(hashes).not.toContain(backupCodes[0]);
    });

    it('AU-037 no confirma un cambio que nadie empezó', async () => {
      findById.mockResolvedValue(enrolledUser());

      await expect(
        service.confirmChange('user-1', '123456'),
      ).rejects.toBeInstanceOf(MfaChangeNotStartedError);

      expect(verify).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
      expect(replaceMfaSecretWithBackupCodes).not.toHaveBeenCalled();
    });

    it('AU-037 quien pierde la carrera de la confirmación no recibe lote alguno', async () => {
      /**
       * DOS REMATRÍCULAS A LA VEZ. La condición «todavía no está matriculado»
       * que arbitra AU-005 aquí no vale: `mfaEnabledAt` SÍ está puesto. La
       * sustituye reclamar el secreto pendiente EXACTO que se acaba de
       * verificar, evaluada por la base en la misma sentencia que escribe. Si
       * otra petición ya lo canjeó —o el cambio se volvió a empezar y el
       * pendiente es otro— esta no escribe nada, y devolver sus diez códigos
       * dejaría a la persona apuntando una lista que no abre nada.
       */
      findById.mockResolvedValue(
        enrolledUser({ mfaPendingSecretEncrypted: 'encrypted-new-secret' }),
      );
      replaceMfaSecretWithBackupCodes.mockResolvedValue(false);

      await expect(
        service.confirmChange('user-1', '123456'),
      ).rejects.toBeInstanceOf(MfaChangeNotStartedError);
    });

    it('AU-037 responde a una cuenta desaparecida como a una sesión perdida', async () => {
      findById.mockResolvedValue(null);

      await expect(
        service.startChange('ghost', '123456'),
      ).rejects.toBeInstanceOf(SessionUserMissingError);
      await expect(
        service.confirmChange('ghost', '123456'),
      ).rejects.toBeInstanceOf(SessionUserMissingError);
    });
  });
});
