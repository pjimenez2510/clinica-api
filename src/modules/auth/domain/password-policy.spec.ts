import { describe, expect, it } from 'vitest';

import {
  assertValidPassword,
  validatePassword,
  WeakPasswordError,
} from './password-policy';

describe('validatePassword', () => {
  it('accepts a long passphrase with no composition rules', () => {
    // No uppercase, no digits, no symbols — and still far stronger than
    // `Password1!`. Length is what matters.
    expect(validatePassword('el caballo come alfalfa temprano')).toEqual([]);
  });

  it('rejects insufficient length', () => {
    expect(validatePassword('corta123')).toContain(
      'debe tener al menos 12 caracteres',
    );
  });

  it('rejects huge inputs, a DoS vector through hashing', () => {
    expect(validatePassword('a'.repeat(300))).toContain(
      'no puede superar 256 caracteres',
    );
  });

  it('rejects known trivial passwords', () => {
    expect(validatePassword('administrador')).toContain(
      'es una contraseña demasiado común',
    );
  });

  it('ignores accents when comparing against the forbidden list', () => {
    // `contraseña` and `contrasena` must be treated the same.
    expect(validatePassword('contraseña')).toContain(
      'es una contraseña demasiado común',
    );
  });

  it('rejects a repeated character and keyboard sequences', () => {
    expect(validatePassword('aaaaaaaaaaaaaa')).toContain(
      'no puede ser un mismo carácter repetido',
    );
    expect(validatePassword('qwertyuiop1234')).toContain(
      'no puede ser una secuencia del teclado',
    );
  });

  describe("the user's own data", () => {
    const user = {
      email: 'jperez@clinica.ec',
      firstName: 'Juan',
      lastName: 'Pérez',
      cedula: '1710034065',
    };

    it('rejects when it contains the email local part', () => {
      expect(validatePassword('jperez-mi-clave-larga', user)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('rejects when it contains the last name even without the accent', () => {
      expect(validatePassword('perez-mi-clave-larga', user)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('rejects when it contains the cedula', () => {
      expect(validatePassword('clave1710034065aqui', user)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('ignores fragments too short to be meaningful', () => {
      // "Ana" is 3 characters: requiring its absence would ban far too many
      // legitimate passwords by coincidence.
      expect(
        validatePassword('la manana es tranquila', { firstName: 'Ana' }),
      ).toEqual([]);
    });
  });

  it('returns ALL reasons, not just the first one', () => {
    // Discovering them one at a time exhausts the user and ends in worse
    // passwords.
    expect(validatePassword('aaa').length).toBeGreaterThan(1);
  });
});

describe('assertValidPassword', () => {
  it('does not throw on a valid password', () => {
    expect(() => assertValidPassword('el caballo come alfalfa')).not.toThrow();
  });

  it('throws WeakPasswordError with the stable code', () => {
    try {
      assertValidPassword('corta');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WeakPasswordError);
      expect((e as WeakPasswordError).code).toBe('WEAK_PASSWORD');
    }
  });

  it('NEVER includes the password in the error', () => {
    // The message ends up in logs and support tickets.
    const secret = 'mi-password-secreta-123';
    try {
      assertValidPassword(secret, { email: 'mi-password-secreta@x.ec' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as WeakPasswordError;
      expect(err.message).not.toContain(secret);
      expect(JSON.stringify(err.params)).not.toContain(secret);
    }
  });
});
