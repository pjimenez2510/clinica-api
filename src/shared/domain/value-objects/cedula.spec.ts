import { describe, expect, it } from 'vitest';

import { Cedula, CedulaInvalidaError } from './cedula.vo';

describe('Cedula', () => {
  // Cédulas con dígito verificador correcto, comprobadas a mano contra el
  // algoritmo módulo 10. Son números de prueba, no de personas reales.
  const VALIDAS = [
    '1710034065', // Pichincha
    '1713175071', // Pichincha
    '0102030400', // Azuay
    '2400000010', // Santa Elena (última provincia)
    '3000000012', // extranjeros
  ];

  describe('acepta cédulas válidas', () => {
    it.each(VALIDAS)('%s', (numero) => {
      expect(Cedula.crear(numero).toString()).toBe(numero);
    });
  });

  describe('rechaza por formato', () => {
    it.each([
      ['cadena vacía', ''],
      ['muy corta', '171003406'],
      ['muy larga', '17100340651'],
      ['con letras', '17100J4065'],
      ['con guiones', '171-003-406'],
    ])('%s', (_caso, entrada) => {
      expect(() => Cedula.crear(entrada)).toThrow(CedulaInvalidaError);
    });

    it('tolera espacios alrededor', () => {
      expect(Cedula.crear('  1710034065  ').toString()).toBe('1710034065');
    });
  });

  describe('rechaza por provincia', () => {
    it.each([
      ['provincia 00', '0010034065'],
      ['provincia 25 (no existe)', '2510034062'],
      ['provincia 29 (no existe)', '2910034069'],
      ['provincia 31 (no existe)', '3110034060'],
    ])('%s', (_caso, entrada) => {
      expect(() => Cedula.crear(entrada)).toThrow(CedulaInvalidaError);
    });
  });

  it('rechaza tercer dígito >= 6, que corresponde a RUC y no a cédula', () => {
    // 6 = sector público, 9 = sociedad privada. Ninguno existe como cédula.
    expect(() => Cedula.crear('1760034060')).toThrow(CedulaInvalidaError);
    expect(() => Cedula.crear('1790034068')).toThrow(CedulaInvalidaError);
  });

  it('rechaza cuando el dígito verificador no coincide', () => {
    // Mismo número válido con el último dígito alterado: todos deben fallar.
    const base = '171003406';
    const verificadorCorrecto = 5;

    for (let d = 0; d <= 9; d++) {
      if (d === verificadorCorrecto) continue;
      expect(() => Cedula.crear(`${base}${d}`)).toThrow(CedulaInvalidaError);
    }
  });

  it('el error no filtra el número rechazado', () => {
    // El mensaje acaba en logs y tickets: no puede llevar el dato personal.
    try {
      Cedula.crear('1710034060');
      expect.unreachable('debió lanzar');
    } catch (e) {
      expect((e as Error).message).not.toContain('1710034060');
      expect((e as CedulaInvalidaError).code).toBe('CEDULA_INVALIDA');
    }
  });

  describe('comportamiento', () => {
    it('expone la provincia', () => {
      expect(Cedula.crear('1710034065').provincia).toBe(17);
      expect(Cedula.crear('0102030400').provincia).toBe(1);
    });

    it('enmascara para mostrar en pantalla', () => {
      expect(Cedula.crear('1710034065').enmascarada()).toBe('171****065');
    });

    it('compara por valor, no por referencia', () => {
      expect(Cedula.crear('1710034065').equals(Cedula.crear('1710034065'))).toBe(true);
      expect(Cedula.crear('1710034065').equals(Cedula.crear('1713175071'))).toBe(false);
    });

    it('esValida no lanza', () => {
      expect(Cedula.esValida('1710034065')).toBe(true);
      expect(Cedula.esValida('basura')).toBe(false);
    });
  });
});
