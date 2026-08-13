import { describe, expect, it } from 'vitest';

import { ParameterOutOfRangeError } from './configuration.errors';
import {
  assertLeadWindowCoherent,
  assertParametersInRange,
  DEFAULT_SITE_PARAMETERS,
  PARAMETER_RANGES,
} from './site-parameters';

/**
 * The rules of the four numbers of D-001, with no database in sight.
 *
 * What the base guarantees is proved against the base in
 * `test/integration/configuration-http.spec.ts`; what is proved here is that
 * the application refuses the same values FIRST and, above all, that it says
 * which range was missed — which a `23514` from PostgreSQL cannot do and CF-065
 * demands.
 */
describe('los parámetros de operación de una sede', () => {
  const inRange = {
    minLeadMinutes: 30,
    maxLeadDays: 90,
    overbookingCap: 3,
  };

  it('CF-062 arranca con los valores que fijó D-001', () => {
    // Not a tautology: these four numbers are also the column DEFAULTs of the
    // migration, and the integration suite asserts the base writes exactly
    // these when a site is created. If somebody changes one here without
    // changing the other, the two tests disagree and one of them fails.
    expect(DEFAULT_SITE_PARAMETERS).toEqual({
      minLeadMinutes: 0,
      maxLeadDays: 180,
      overbookingCap: 2,
      cancelledRetention: 'NEVER',
    });
  });

  it('CF-065 acepta un cambio dentro de rango sin decir nada', () => {
    expect(() => {
      assertParametersInRange(inRange);
    }).not.toThrow();
  });

  it('CF-065 acepta los extremos exactos de cada rango', () => {
    // An off-by-one here would refuse «0 minutos de antelación», which is the
    // default D-001 chose, and reception would be unable to save the form.
    expect(() => {
      assertParametersInRange({
        minLeadMinutes: PARAMETER_RANGES.minLeadMinutes.min,
        maxLeadDays: PARAMETER_RANGES.maxLeadDays.max,
        overbookingCap: PARAMETER_RANGES.overbookingCap.max,
      });
    }).not.toThrow();
  });

  it('CF-065 rechaza un tope de sobrecupos negativo y nombra el rango', () => {
    try {
      assertParametersInRange({ overbookingCap: -1 });
      expect.unreachable('debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(ParameterOutOfRangeError);
      const problem = error as ParameterOutOfRangeError;
      expect(problem.code).toBe('PARAM_OUT_OF_RANGE');
      expect(problem.fieldErrors).toEqual([
        {
          field: 'overbookingCap',
          code: 'PARAM_OUT_OF_RANGE',
          message: 'El tope de sobrecupos va de 0 a 20',
        },
      ]);
    }
  });

  it('CF-065 rechaza una antelación máxima por encima del tope', () => {
    expect(() => {
      assertParametersInRange({ maxLeadDays: 731 });
    }).toThrow(ParameterOutOfRangeError);
  });

  it('CF-065 rechaza una antelación mínima de cero días menos un minuto', () => {
    expect(() => {
      assertParametersInRange({ minLeadMinutes: -1 });
    }).toThrow(ParameterOutOfRangeError);
  });

  it('CF-065 rechaza un valor que no es entero', () => {
    // `int` en PostgreSQL truncaría 2.5 a 2 sin decir nada, y el tope de
    // sobrecupos habría cambiado a espaldas de quien lo escribió.
    expect(() => {
      assertParametersInRange({ overbookingCap: 2.5 });
    }).toThrow(ParameterOutOfRangeError);
  });

  it('CF-065 informa de TODOS los parámetros fuera de rango a la vez', () => {
    // Corregir de uno en uno son cuatro viajes, y así es como una pantalla de
    // configuración se queda a medio configurar.
    try {
      assertParametersInRange({
        minLeadMinutes: -5,
        maxLeadDays: 0,
        overbookingCap: 99,
      });
      expect.unreachable('debía rechazarse');
    } catch (error) {
      const fields = (error as ParameterOutOfRangeError).fieldErrors?.map(
        (e) => e.field,
      );
      expect(fields).toEqual([
        'minLeadMinutes',
        'maxLeadDays',
        'overbookingCap',
      ]);
    }
  });

  it('CF-065 ignora los parámetros que el administrador no envió', () => {
    // Un PUT parcial es lo normal: subir el tope de sobrecupos no obliga a
    // reenviar las dos antelaciones, y reenviar una copia vieja es como se
    // revierte en silencio el cambio de otra persona.
    expect(() => {
      assertParametersInRange({});
    }).not.toThrow();
  });

  it('CF-065 rechaza una ventana de reserva que no deja ninguna hora reservable', () => {
    try {
      assertLeadWindowCoherent({
        minLeadMinutes: 10_080,
        maxLeadDays: 1,
        overbookingCap: 2,
        cancelledRetention: 'NEVER',
      });
      expect.unreachable('debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(ParameterOutOfRangeError);
      expect((error as ParameterOutOfRangeError).fieldErrors?.[0]?.field).toBe(
        'minLeadMinutes',
      );
    }
  });

  it('CF-065 acepta la ventana cuando la mínima cabe justo en la máxima', () => {
    expect(() => {
      assertLeadWindowCoherent({
        minLeadMinutes: 1440,
        maxLeadDays: 1,
        overbookingCap: 2,
        cancelledRetention: 'NEVER',
      });
    }).not.toThrow();
  });

  it('CF-063 no declara rango para nada que sea una garantía del sistema', () => {
    // La lista de parámetros con rango ES la lista de lo configurable. Si
    // mañana alguien añade aquí un `allowOverlap` o un `historyImmutable`, esta
    // prueba lo caza antes que ninguna otra: CF-063 dice que eso no es un
    // parámetro, es una garantía, y configurarla es perderla (REQ-146).
    expect(Object.keys(PARAMETER_RANGES)).toEqual([
      'minLeadMinutes',
      'maxLeadDays',
      'overbookingCap',
    ]);
  });
});
