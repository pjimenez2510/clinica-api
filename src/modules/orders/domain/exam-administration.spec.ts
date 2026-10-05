import { describe, expect, it } from 'vitest';

import type { ReferenceRange } from './analyte';
import {
  assertAnalyteFitsItsType,
  assertRangesHold,
  overlap,
} from './exam-administration';

/**
 * ORD-104 a ORD-107. Lo que el catálogo de exámenes no deja escribir, con los
 * rangos reales de la siembra: `HB` partido por sexo y `GLU` con banda crítica.
 */

const range = (overrides: Partial<ReferenceRange> = {}): ReferenceRange => ({
  rangeKind: 'REFERENCE',
  sex: null,
  ageMinDays: null,
  ageMaxDays: null,
  low: null,
  high: null,
  text: null,
  ...overrides,
});

const messagesOf = (fn: () => void): string[] => {
  try {
    fn();
  } catch (error) {
    return ((error as { fieldErrors?: { message: string }[] }).fieldErrors ?? []).map((f) => f.message); // prettier-ignore
  }
  return [];
};

const fieldsOf = (fn: () => void): string[] => {
  try {
    fn();
  } catch (error) {
    return ((error as { fieldErrors?: { field: string }[] }).fieldErrors ?? []).map((f) => f.field); // prettier-ignore
  }
  return [];
};

describe('el analito casa con su tipo de valor', () => {
  it('ORD-104 un numérico lleva unidad y no lleva lista', () => {
    expect(
      () =>
      assertAnalyteFitsItsType({ valueType: 'NUMERIC', unit: 'g/dL', decimals: 1, allowedValues: null }), // prettier-ignore
    ).not.toThrow();
    expect(
      fieldsOf(
        () =>
        assertAnalyteFitsItsType({ valueType: 'NUMERIC', unit: ' ', decimals: 1, allowedValues: ['Alto', 'Bajo'] }), // prettier-ignore
      ),
    ).toEqual(['unit', 'allowedValues']);
  });

  it('ORD-104 un codificado lleva al menos dos respuestas distintas y ningún decimal', () => {
    expect(
      () =>
      assertAnalyteFitsItsType({ valueType: 'CODED', unit: null, decimals: null, allowedValues: ['Negativo', 'Positivo'] }), // prettier-ignore
    ).not.toThrow();
    expect(
      fieldsOf(
        () =>
        assertAnalyteFitsItsType({ valueType: 'CODED', unit: null, decimals: 0, allowedValues: ['Positivo', 'positivo'] }), // prettier-ignore
      ),
    ).toEqual(['decimals', 'allowedValues']);
  });

  it('ORD-104 un texto libre no lleva lista', () => {
    expect(
      fieldsOf(
        () =>
        assertAnalyteFitsItsType({ valueType: 'TEXT', unit: null, decimals: null, allowedValues: ['Uno'] }), // prettier-ignore
      ),
    ).toEqual(['allowedValues']);
  });
});

describe('los rangos de un analito', () => {
  it('ORD-106 HB partido por sexo y GLU con banda crítica se guardan', () => {
    expect(() =>
      assertRangesHold('NUMERIC', [
        range({ sex: 'MALE', low: 13, high: 17 }),
        range({ sex: 'FEMALE', low: 12, high: 15.5 }),
      ]),
    ).not.toThrow();
    expect(() =>
      assertRangesHold('NUMERIC', [
        range({ low: 70, high: 100 }),
        range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
      ]),
    ).not.toThrow();
  });

  it('ORD-106 nombra la fila de un rango imposible', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('NUMERIC', [
          range({ low: 70, high: 100 }),
          range({ sex: 'MALE', low: 17, high: 13, ageMinDays: 30, ageMaxDays: 10 }), // prettier-ignore
          range(),
        ]),
      ),
    ).toEqual(['ranges[1].high', 'ranges[1].ageMaxDays', 'ranges[2].low']);
  });

  it('ORD-106 una determinación codificada no lleva límites ni rango crítico', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('CODED', [
          range({ text: 'Negativo' }),
          range({ rangeKind: 'CRITICAL', low: 1 }),
        ]),
      ),
    ).toEqual(['ranges[1].low', 'ranges[1].rangeKind']);
  });

  it('ORD-107 dos rangos igual de específicos que se pisan se rechazan', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('NUMERIC', [
          range({ low: 70, high: 100 }),
          range({ low: 60, high: 110 }),
        ]),
      ),
    ).toEqual(['ranges[1].sex']);
  });

  it('ORD-107 uno más estrecho junto a uno general no se pisa: ORD-036 toma el estrecho', () => {
    expect(overlap(range(), range({ sex: 'MALE' }))).toBe(false);
    expect(overlap(range(), range({ ageMaxDays: 28 }))).toBe(false);
    expect(overlap(range({ rangeKind: 'CRITICAL' }), range())).toBe(false);
  });

  it('ORD-107 las ventanas de edad que se tocan se pisan; las que no, no', () => {
    expect(
      overlap(range({ ageMinDays: 0, ageMaxDays: 28 }), range({ ageMinDays: 28, ageMaxDays: 365 })), // prettier-ignore
    ).toBe(true);
    expect(
      overlap(range({ ageMinDays: 0, ageMaxDays: 27 }), range({ ageMinDays: 28 })), // prettier-ignore
    ).toBe(false);
  });

  it('ORD-106 un rango numérico de solo texto no clasifica nada: se rechaza', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('NUMERIC', [
          range({ rangeKind: 'CRITICAL', text: 'llamar si sube' }),
        ]),
      ),
    ).toEqual(['ranges[0].low']);
  });

  it('ORD-106 un crítico por sexo con un solo lado se guarda: hereda el otro del general', () => {
    expect(() =>
      assertRangesHold('NUMERIC', [
        range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
        range({ rangeKind: 'CRITICAL', sex: 'MALE', high: 450 }),
      ]),
    ).not.toThrow();
  });

  it('ORD-112 un crítico bajo por encima del límite inferior de referencia se rechaza con los dos valores', () => {
    // 700 en lugar de 70: todas las glucosas saldrían críticas.
    const refuse = () =>
      assertRangesHold('NUMERIC', [
        range({ low: 70, high: 100 }),
        range({ rangeKind: 'CRITICAL', low: 700, high: 900 }),
      ]);
    expect(fieldsOf(refuse)).toContain('ranges[1].low');
    expect(messagesOf(refuse).join(' ')).toMatch(/700.*70/);
  });

  it('ORD-112 un crítico alto por debajo del límite superior de referencia se rechaza', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('NUMERIC', [
          range({ low: 70, high: 100 }),
          range({ rangeKind: 'CRITICAL', low: 40, high: 90 }),
        ]),
      ),
    ).toEqual(['ranges[1].high']);
  });

  it('ORD-112 el crítico igual al límite de referencia se admite: es el borde de la banda', () => {
    expect(() =>
      assertRangesHold('NUMERIC', [
        range({ low: 70, high: 100 }),
        range({ rangeKind: 'CRITICAL', low: 70, high: 100 }),
      ]),
    ).not.toThrow();
  });

  it('ORD-112 compara con la resolución de la bandera: el crítico general contra la referencia de cada sexo', () => {
    // La referencia de las mujeres baja hasta 30; el crítico general de 40
    // marcaría crítica a una mujer normal. Se nombra la fila del crítico.
    const refuse = () =>
      assertRangesHold('NUMERIC', [
        range({ sex: 'MALE', low: 80, high: 120 }),
        range({ sex: 'FEMALE', low: 30, high: 120 }),
        range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
      ]);
    expect(fieldsOf(refuse)).toEqual(['ranges[2].low']);
    expect(messagesOf(refuse).join(' ')).toMatch(/mujeres/);
    // Control positivo: el mismo crítico con la referencia femenina en 45 entra.
    expect(() =>
      assertRangesHold('NUMERIC', [
        range({ sex: 'MALE', low: 80, high: 120 }),
        range({ sex: 'FEMALE', low: 45, high: 120 }),
        range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
      ]),
    ).not.toThrow();
  });

  it('ORD-112 el lado heredado también se compara: el bajo general contra la referencia del varón', () => {
    expect(
      fieldsOf(() =>
        assertRangesHold('NUMERIC', [
          range({ low: 70, high: 100 }),
          range({ sex: 'MALE', ageMinDays: 0, ageMaxDays: 27, low: 30, high: 100 }), // prettier-ignore
          range({ rangeKind: 'CRITICAL', low: 40, high: 400 }),
          range({ rangeKind: 'CRITICAL', sex: 'MALE', high: 450 }),
        ]),
      ),
    ).toEqual(['ranges[2].low']);
  });
});
