import { describe, expect, it } from 'vitest';

import { SubjectStatusNotDerivableError } from './agenda.errors';
import type { PatientSubjectStatus } from './agenda-entry';
import {
  DERIVED_SUBJECT_STATUSES,
  TYPED_SUBJECT_STATUS,
  assertSubjectStatusMayMove,
  subjectStatusOf,
  type SubjectStatusFact,
} from './subject-status';

/**
 * AG-121 a AG-127. El eje del paciente y la regla de que sólo uno de sus seis
 * valores se teclea.
 *
 * LO QUE ESTE ARCHIVO NO PUEDE PROBAR es que no exista una ruta que los fije a
 * mano: la ausencia de algo no se comprueba contra un doble de ese algo. Eso
 * lo recorre `test/integration/agenda-subject-status.spec.ts` sobre las rutas
 * que NestJS registró de verdad, con la misma máquina de AG-070.
 */

const arrived = (
  overrides: {
    kind?: 'APPOINTMENT' | 'BLOCK';
    subjectStatus?: PatientSubjectStatus | null;
  } = {},
) => ({
  kind: 'APPOINTMENT' as const,
  subjectStatus: 'ARRIVED' as PatientSubjectStatus | null,
  ...overrides,
});

describe('el eje del paciente', () => {
  it('AG-121 tiene seis valores y ARRIVED es el único que se teclea', () => {
    // Cinco derivados más el que se teclea: si el enum crece, esta suma deja
    // de cuadrar y alguien tiene que decidir de qué hecho sale el nuevo.
    expect(TYPED_SUBJECT_STATUS).toBe('ARRIVED');
    expect(DERIVED_SUBJECT_STATUSES).toHaveLength(5);
    expect(DERIVED_SUBJECT_STATUSES).not.toContain('ARRIVED');
  });

  it('AG-122 deriva cada estado del hecho documentado que lo produce', () => {
    const expected: readonly [SubjectStatusFact, PatientSubjectStatus][] = [
      ['VITALS_STARTED', 'IN_PREPARATION'],
      ['VITALS_RECORDED', 'READY'],
      ['CLINICAL_NOTE_OPENED', 'RECEIVING_CARE'],
      ['TEMPORARY_LEAVE_RECORDED', 'ON_LEAVE'],
      ['ACCOUNT_CLOSED', 'DEPARTED'],
    ];

    for (const [fact, status] of expected) {
      expect(subjectStatusOf(fact)).toBe(status);
    }
  });

  it('AG-122 cubre con hechos los cinco estados que nadie puede teclear', () => {
    // La otra mitad de la anterior, y la que importa: si un estado derivado se
    // quedara sin hecho que lo produzca, la única forma de alcanzarlo sería la
    // casilla que este requisito prohíbe.
    const facts: readonly SubjectStatusFact[] = [
      'VITALS_STARTED',
      'VITALS_RECORDED',
      'CLINICAL_NOTE_OPENED',
      'TEMPORARY_LEAVE_RECORDED',
      'ACCOUNT_CLOSED',
    ];
    const reachable = new Set(facts.map(subjectStatusOf));

    for (const status of DERIVED_SUBJECT_STATUSES) {
      expect(reachable.has(status)).toBe(true);
    }
  });

  it('AG-123 no introduce ningún estado de espera entre pasos de la atención', () => {
    /**
     * Es la definición textual de FHIR R5: `receiving-care` incluye «periods
     * of waiting between care». Un estado «esperando resultado» partiría el
     * tiempo de una misma visita en trozos, y entonces el tiempo en el estado
     * actual (AG-135) se reiniciaría cada vez que alguien entra y sale del
     * consultorio, justo cuando más importa que siga corriendo.
     *
     * `READY` no lo contradice: ésa es la espera ANTES de que la atención se
     * abra, cuando todavía no hay nada en curso.
     */
    expect(DERIVED_SUBJECT_STATUSES).toEqual([
      'IN_PREPARATION',
      'READY',
      'RECEIVING_CARE',
      'ON_LEAVE',
      'DEPARTED',
    ]);
  });

  it('AG-124 no da por terminado el paso por la clínica al salir temporalmente', () => {
    // El caso real es el laboratorio externo: el paciente se va y vuelve, y su
    // atención sigue abierta. `ON_LEAVE` y `DEPARTED` son estados distintos
    // precisamente para que nadie cierre lo primero usando lo segundo.
    expect(subjectStatusOf('TEMPORARY_LEAVE_RECORDED')).toBe('ON_LEAVE');
    expect(subjectStatusOf('TEMPORARY_LEAVE_RECORDED')).not.toBe('DEPARTED');
  });

  it('AG-125 rechaza cualquier movimiento posterior a DEPARTED', () => {
    expect(() =>
      assertSubjectStatusMayMove(arrived({ subjectStatus: 'DEPARTED' })),
    ).toThrow(SubjectStatusNotDerivableError);
  });

  it('AG-127 rechaza asignar estado de paciente antes de la llegada', () => {
    // Una cita en BOOKED no tiene a nadie en ningún sitio, y darle un estado
    // llenaría el tablero de gente que no ha venido — la clase de mentira que
    // AG-122 evita.
    expect(() =>
      assertSubjectStatusMayMove(arrived({ subjectStatus: null })),
    ).toThrow(SubjectStatusNotDerivableError);
  });

  it('AG-021 rechaza estado de paciente en un bloqueo', () => {
    // Un quirófano no está en preconsulta. La base lo rechaza también
    // (`agenda_entry_subject_status_needs_a_patient`).
    expect(() =>
      assertSubjectStatusMayMove(
        arrived({ kind: 'BLOCK', subjectStatus: null }),
      ),
    ).toThrow(SubjectStatusNotDerivableError);
  });

  it('AG-122 admite el movimiento sobre quien llegó y no se ha ido', () => {
    expect(() => assertSubjectStatusMayMove(arrived())).not.toThrow();
    expect(() =>
      assertSubjectStatusMayMove(arrived({ subjectStatus: 'RECEIVING_CARE' })),
    ).not.toThrow();
  });

  it('AG-126 distingue «todavía no llegó» de «ya salió» en el error', () => {
    // El código es uno solo porque lo que hay que hacer es lo mismo —nada—,
    // pero el parámetro deja constancia de cuál de los dos casos fue.
    const before = (() => {
      try {
        assertSubjectStatusMayMove(arrived({ subjectStatus: null }));
      } catch (error) {
        return error as SubjectStatusNotDerivableError;
      }
      return undefined;
    })();
    const after = (() => {
      try {
        assertSubjectStatusMayMove(arrived({ subjectStatus: 'DEPARTED' }));
      } catch (error) {
        return error as SubjectStatusNotDerivableError;
      }
      return undefined;
    })();

    expect(before?.params).toEqual({ current: 'NONE' });
    expect(after?.params).toEqual({ current: 'DEPARTED' });
  });
});
