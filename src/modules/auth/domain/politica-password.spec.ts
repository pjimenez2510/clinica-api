import { describe, expect, it } from 'vitest';

import {
  asegurarPasswordValida,
  PasswordDebilError,
  validarPassword,
} from './politica-password';

describe('validarPassword', () => {
  it('acepta una frase larga sin reglas de composición', () => {
    // Sin mayúsculas, sin números, sin símbolos: y aun así es mucho más fuerte
    // que `Password1!`. La longitud es lo que manda.
    expect(validarPassword('el caballo come alfalfa temprano')).toEqual([]);
  });

  it('rechaza por longitud insuficiente', () => {
    expect(validarPassword('corta123')).toContain(
      'debe tener al menos 12 caracteres',
    );
  });

  it('rechaza entradas enormes, que son un vector de DoS por hashing', () => {
    expect(validarPassword('a'.repeat(300))).toContain(
      'no puede superar 256 caracteres',
    );
  });

  it('rechaza contraseñas triviales conocidas', () => {
    expect(validarPassword('administrador')).toContain(
      'es una contraseña demasiado común',
    );
  });

  it('ignora tildes al comparar con la lista de prohibidas', () => {
    // `contraseña` y `contrasena` deben tratarse igual.
    expect(validarPassword('contraseña')).toContain(
      'es una contraseña demasiado común',
    );
  });

  it('rechaza un carácter repetido y las secuencias de teclado', () => {
    expect(validarPassword('aaaaaaaaaaaaaa')).toContain(
      'no puede ser un mismo carácter repetido',
    );
    expect(validarPassword('qwertyuiop1234')).toContain(
      'no puede ser una secuencia del teclado',
    );
  });

  describe('datos del propio usuario', () => {
    const usuario = {
      correo: 'jperez@clinica.ec',
      nombres: 'Juan',
      apellidos: 'Pérez',
      cedula: '1710034065',
    };

    it('rechaza si contiene el usuario del correo', () => {
      expect(validarPassword('jperez-mi-clave-larga', usuario)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('rechaza si contiene el apellido aunque cambie la tilde', () => {
      expect(validarPassword('perez-mi-clave-larga', usuario)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('rechaza si contiene la cédula', () => {
      expect(validarPassword('clave1710034065aqui', usuario)).toContain(
        'no puede contener tu nombre, correo ni cédula',
      );
    });

    it('ignora fragmentos demasiado cortos para ser significativos', () => {
      // "Ana" tiene 3 caracteres: exigir que no aparezca prohibiría demasiadas
      // contraseñas legítimas por casualidad.
      expect(
        validarPassword('la manana es tranquila', { nombres: 'Ana' }),
      ).toEqual([]);
    });
  });

  it('devuelve TODOS los motivos, no solo el primero', () => {
    // Descubrirlos de uno en uno agota al usuario y termina en peores claves.
    expect(validarPassword('aaa').length).toBeGreaterThan(1);
  });
});

describe('asegurarPasswordValida', () => {
  it('no lanza con una contraseña válida', () => {
    expect(() =>
      asegurarPasswordValida('el caballo come alfalfa'),
    ).not.toThrow();
  });

  it('lanza PasswordDebilError con el código estable', () => {
    try {
      asegurarPasswordValida('corta');
      expect.unreachable('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(PasswordDebilError);
      expect((e as PasswordDebilError).code).toBe('PASSWORD_DEBIL');
    }
  });

  it('NUNCA incluye la contraseña en el error', () => {
    // El mensaje acaba en logs y en tickets de soporte.
    const secreta = 'mi-password-secreta-123';
    try {
      asegurarPasswordValida(secreta, { correo: 'mi-password-secreta@x.ec' });
      expect.unreachable('debió lanzar');
    } catch (e) {
      const err = e as PasswordDebilError;
      expect(err.message).not.toContain(secreta);
      expect(JSON.stringify(err.params)).not.toContain(secreta);
    }
  });
});
