import { describe, expect, it } from 'vitest';

import { ParameterOutOfRangeError } from './configuration.errors';
import { PERMISSIONS } from '../../../shared/authorisation/permission.catalogue';
import { UnknownPermissionError } from '../../../shared/domain/errors/permission.errors';
import {
  assertAtomFitsStoredDurations,
  assertLeadWindowCoherent,
  assertParametersInRange,
  assertPermissionIsDeclared,
  DEFAULT_SITE_PARAMETERS,
  PARAMETER_RANGES,
} from './site-parameters';

/**
 * The rules of a site's operating parameters, with no database in sight.
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
    /**
     * WHAT THIS ASSERTS, AND WHAT IT DOES NOT. It pins the constant against
     * the values written down in D-001 — plus `allowPastBooking: false`, the
     * conservative default the E7 migration chose — so changing any of them is
     * a failing test somebody has to look at, and not a silent edit.
     *
     * It does NOT compare anything against the database: this is a literal
     * against a literal, with no PostgreSQL in the process. The same numbers
     * are also the column DEFAULTs of
     * `20260813040610_configuration_holidays_and_site_parameters` and of the
     * E7 migration, and that the two copies agree is asserted separately, by
     * `test/integration/configuration-http.spec.ts` reading back a site the
     * trigger has just parametrised. Two tests over two sources; nothing here
     * makes the base fail because this constant moved.
     */
    expect(DEFAULT_SITE_PARAMETERS).toEqual({
      minLeadMinutes: 0,
      maxLeadDays: 180,
      overbookingCap: 2,
      // D-021: el único valor de la banda estándar del que son múltiplos las
      // tres duraciones ya configuradas (10, 20 y 30).
      slotAtomMinutes: 10,
      allowPastBooking: false,
      // E4, D-005 (14-08-2026). El sobrecupo nace HABILITADO —al revés que el
      // pasado, y a propósito: es la vía documentada de la excepción, y lo que
      // la limita es el tope de arriba— y lo autoriza el permiso que MEDICO y
      // ADMIN traen de fábrica.
      overbookingEnabled: true,
      overbookingPermission: 'agenda:overbook',
      waitlistMaxContactAttempts: 3,
      cancelledRetention: 'NEVER',
      criticalNoticeWithinMinutes: null,
      criticalEscalationRoleId: null,
      unmatchedResultOwnerRoleId: null,
      unmatchedResultDeadlineHours: 24,
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
        slotAtomMinutes: 10,
        allowPastBooking: false,
        overbookingEnabled: true,
        overbookingPermission: 'agenda:overbook',
        waitlistMaxContactAttempts: 3,
        cancelledRetention: 'NEVER',
        criticalNoticeWithinMinutes: null,
        criticalEscalationRoleId: null,
        unmatchedResultOwnerRoleId: null,
        unmatchedResultDeadlineHours: 24,
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
        slotAtomMinutes: 10,
        allowPastBooking: false,
        overbookingEnabled: true,
        overbookingPermission: 'agenda:overbook',
        waitlistMaxContactAttempts: 3,
        cancelledRetention: 'NEVER',
        criticalNoticeWithinMinutes: null,
        criticalEscalationRoleId: null,
        unmatchedResultOwnerRoleId: null,
        unmatchedResultDeadlineHours: 24,
      });
    }).not.toThrow();
  });

  it('AG-101 rechaza un permiso que el catálogo del código no declara', () => {
    /**
     * ES EL ÚNICO CÓDIGO DE PERMISO QUE ESTE ESQUEMA GUARDA COMO DATO, y lo
     * que pasa si entra con una errata no es un error visible: `agenda:overbok`
     * no lo tiene NADIE, así que la sede se queda sin poder autorizar
     * sobrecupos y nada en pantalla lo dice. Qué permisos existen es código.
     */
    try {
      assertPermissionIsDeclared('agenda:overbok', [...PERMISSIONS]);
      expect.unreachable('debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPermissionError);
      expect((error as UnknownPermissionError).code).toBe('UNKNOWN_PERMISSION');
      // Bajo el campo que lo produjo, no bajo el `permissions` de la pantalla
      // de roles: es otro formulario y otra casilla.
      expect((error as UnknownPermissionError).fieldErrors?.[0]?.field).toBe(
        'overbookingPermission',
      );
      expect(
        (error as UnknownPermissionError).fieldErrors?.[0]?.message,
      ).toContain('agenda:overbok');
    }
  });

  it('AG-101 admite cualquier permiso que el catálogo SÍ declara', () => {
    // No se estrecha a «los del sobrecupo»: quién autoriza una excepción es
    // política de la clínica (D-002), y una lista corta aquí sería este módulo
    // decidiéndola. Lo que no se admite es un código que no existe.
    expect(() =>
      assertPermissionIsDeclared('agenda:overbook', [...PERMISSIONS]),
    ).not.toThrow();
    expect(() =>
      assertPermissionIsDeclared('settings:manage', [...PERMISSIONS]),
    ).not.toThrow();
  });

  it('CF-063 no declara rango para nada que sea una garantía del sistema', () => {
    // La lista de parámetros con rango ES la lista de lo configurable con
    // límites. Si mañana alguien añade aquí un `allowOverlap` o un
    // `historyImmutable`, esta prueba lo caza antes que ninguna otra: CF-063
    // dice que eso no es un parámetro, es una garantía, y configurarla es
    // perderla (REQ-146).
    //
    // `allowPastBooking` NO FALTA: es un booleano y un booleano no tiene rango
    // —sus dos valores son legítimos—, así que `assertParametersInRange` no
    // tiene nada que comprobar sobre él.
    expect(Object.keys(PARAMETER_RANGES)).toEqual([
      'minLeadMinutes',
      'maxLeadDays',
      'overbookingCap',
      'slotAtomMinutes',
      // AG-066, AG-094 (E5): cuántas llamadas agotan una entrada de lista de
      // espera. Pertenece a la lista por lo mismo que los anteriores —nada
      // deja de garantizarse por configurarlo—, y el número dentro del rango
      // es decisión de la clínica (D-040), no del código.
      'waitlistMaxContactAttempts',
      // ORD-063, ORD-065, ORD-046: los plazos de las colas de resultados. El
      // valor dentro del rango es de la clínica (D-050, D-111).
      'criticalNoticeWithinMinutes',
      'unmatchedResultDeadlineHours',
    ]);
  });

  it('ORD-065 admite «sin plazo» para los críticos y acota el plazo cuando se fija', () => {
    // `null` es un valor: la clínica no ha decidido, y la cola lo dice.
    expect(() => assertParametersInRange({ criticalNoticeWithinMinutes: null })).not.toThrow(); // prettier-ignore
    expect(() => assertParametersInRange({ criticalNoticeWithinMinutes: 5 })).not.toThrow(); // prettier-ignore
    expect(() => assertParametersInRange({ criticalNoticeWithinMinutes: 1440 })).not.toThrow(); // prettier-ignore
    for (const criticalNoticeWithinMinutes of [0, 4, 1441, 7.5]) {
      expect(
        () => assertParametersInRange({ criticalNoticeWithinMinutes }),
        `${criticalNoticeWithinMinutes}`,
      ).toThrow(ParameterOutOfRangeError);
    }
  });

  it('ORD-046 acota el plazo de los resultados sin orden y nace en 24 horas', () => {
    expect(DEFAULT_SITE_PARAMETERS.unmatchedResultDeadlineHours).toBe(24);
    expect(DEFAULT_SITE_PARAMETERS.unmatchedResultOwnerRoleId).toBeNull();
    expect(() => assertParametersInRange({ unmatchedResultDeadlineHours: 1 })).not.toThrow(); // prettier-ignore
    expect(() => assertParametersInRange({ unmatchedResultDeadlineHours: 168 })).not.toThrow(); // prettier-ignore
    for (const unmatchedResultDeadlineHours of [0, 169]) {
      expect(() =>
        assertParametersInRange({ unmatchedResultDeadlineHours }),
      ).toThrow(ParameterOutOfRangeError);
    }
  });

  /**
   * D-021. The atom is a number with a range like the other three, and one
   * extra thing: it lands on a step of 5.
   */
  describe('CF-062 el turno de la agenda', () => {
    it('CF-065 acepta un turno de la banda estándar', () => {
      for (const slotAtomMinutes of [5, 10, 15, 20, 30, 60]) {
        expect(() => {
          assertParametersInRange({ slotAtomMinutes });
        }, `${slotAtomMinutes}`).not.toThrow();
      }
    });

    it('CF-065 rechaza un turno fuera de la banda, nombrando el rango', () => {
      try {
        assertParametersInRange({ slotAtomMinutes: 90 });
        expect.unreachable('debía rechazarse');
      } catch (error) {
        expect(error).toBeInstanceOf(ParameterOutOfRangeError);
        const failure = error as ParameterOutOfRangeError;
        expect(failure.fieldErrors?.[0]?.field).toBe('slotAtomMinutes');
        expect(failure.fieldErrors?.[0]?.message).toContain('5 a 60');
      }
    });

    it('CF-065 rechaza un turno que no cae en el paso de cinco', () => {
      // 7 está dentro de 5..60 y no es múltiplo de 5. El paso es lo que
      // mantiene `service_type_duration_range` como CONSECUENCIA de la regla
      // fina en vez de un resto que la contradice.
      expect(() => {
        assertParametersInRange({ slotAtomMinutes: 7 });
      }).toThrow(ParameterOutOfRangeError);
    });

    it('D-021 rechaza un turno que dejaría sin reservar una duración ya configurada', () => {
      // La OTRA mitad de la garantía: hacer múltiplos a las duraciones cierra
      // la puerta por la que entran las duraciones, no la puerta por la que
      // entra el átomo.
      try {
        assertAtomFitsStoredDurations(20, [10, 20, 30]);
        expect.unreachable('debía rechazarse');
      } catch (error) {
        expect(error).toBeInstanceOf(ParameterOutOfRangeError);
        const failure = error as ParameterOutOfRangeError;
        expect(failure.fieldErrors?.[0]?.field).toBe('slotAtomMinutes');
        // Nombra las que estorban: «no puede ser 20» deja a quien administra
        // adivinando cuál de cuarenta tipos de atención se lo impide.
        expect(failure.fieldErrors?.[0]?.message).toContain('10, 30');
      }
    });

    it('D-021 acepta un turno del que toda duración configurada es múltiplo', () => {
      expect(() => {
        assertAtomFitsStoredDurations(10, [10, 20, 30]);
      }).not.toThrow();
    });

    it('D-021 no estorba cuando la clínica no ha configurado ninguna duración', () => {
      expect(() => {
        assertAtomFitsStoredDurations(60, []);
      }).not.toThrow();
    });
  });
});
