import { describe, expect, it } from 'vitest';

import {
  DischargeConditionRequiredError,
  EncounterCloserNotAuthorError,
  InvalidEncounterTransitionError,
  SubstituteClosureReasonRequiredError,
} from './encounter.errors';
import { planClosure, type ClosableEncounter } from './encounter-closure';

/**
 * D-A-010: who closes an attention, and what the closure has to leave written.
 */

const AUTHOR = 'practitioner-who-attended';
const SUBSTITUTE = 'practitioner-covering';
const ENDED_AT = new Date('2026-09-14T15:00:00Z');
const NOW = new Date('2026-09-14T15:40:00Z');

const discharged = (
  overrides: Partial<ClosableEncounter> = {},
): ClosableEncounter => ({
  status: 'DISCHARGED',
  practitionerId: AUTHOR,
  endedAt: ENDED_AT,
  dischargeCondition: 'ALIVE',
  ...overrides,
});

describe('el cierre de la atención', () => {
  it('EN-144 la cierra quien la abrió, sin pedirle ningún motivo', () => {
    const plan = planClosure({
      encounter: discharged(),
      closer: { practitionerId: AUTHOR, canSignRecords: false },
      to: 'COMPLETED',
      now: NOW,
    });

    expect(plan.to).toBe('COMPLETED');
    expect(plan.closedById).toBe(AUTHOR);
    expect(plan.closedAt).toEqual(NOW);
    // `encounter_substitute_closure_states_reason` admits «el mismo
    // profesional, sin motivo»; the shape says so too.
    expect(plan.substituteReason).toBeNull();
  });

  it('EN-131 conserva el instante en que terminó el acto y sella el del cierre aparte', () => {
    // The two are hours apart on the ordinary path, and that gap is the whole
    // reason DISCHARGED and COMPLETED are two states.
    const plan = planClosure({
      encounter: discharged(),
      closer: { practitionerId: AUTHOR, canSignRecords: false },
      to: 'COMPLETED',
      now: NOW,
    });

    expect(plan.endedAt).toEqual(ENDED_AT);
    expect(plan.closedAt).toEqual(NOW);
  });

  it('EN-147 admite que la cierre otro con `record:sign` dejando constancia', () => {
    const plan = planClosure({
      encounter: discharged(),
      closer: {
        practitionerId: SUBSTITUTE,
        canSignRecords: true,
        substituteReason: 'La doctora está de vacaciones desde el lunes',
      },
      to: 'COMPLETED',
      now: NOW,
    });

    expect(plan.closedById).toBe(SUBSTITUTE);
    expect(plan.substituteReason).toBe(
      'La doctora está de vacaciones desde el lunes',
    );
  });

  it('EN-147 rechaza el cierre por sustitución sin motivo escrito', () => {
    expect(() =>
      planClosure({
        encounter: discharged(),
        closer: { practitionerId: SUBSTITUTE, canSignRecords: true },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(SubstituteClosureReasonRequiredError);
  });

  it('EN-147 no acepta un motivo en blanco como constancia', () => {
    // Whitespace satisfies «the field is filled» and satisfies nothing a
    // reader needs twelve months later.
    expect(() =>
      planClosure({
        encounter: discharged(),
        closer: {
          practitionerId: SUBSTITUTE,
          canSignRecords: true,
          substituteReason: '   ',
        },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(SubstituteClosureReasonRequiredError);
  });

  it('EN-144 rechaza que la cierre otro que no firma historia clínica', () => {
    // With a reason and everything: what is missing is the authority, and the
    // refusal is 403 rather than «falta el motivo».
    try {
      planClosure({
        encounter: discharged(),
        closer: {
          practitionerId: SUBSTITUTE,
          canSignRecords: false,
          substituteReason: 'Me lo pidió recepción',
        },
        to: 'COMPLETED',
        now: NOW,
      });
      expect.unreachable('el cierre debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(EncounterCloserNotAuthorError);
      expect((error as EncounterCloserNotAuthorError).code).toBe(
        'ENCOUNTER_CLOSER_NOT_AUTHOR',
      );
    }
  });

  it('EN-144 pregunta QUIÉN antes que nada, para no pedir un motivo a quien no puede cerrar', () => {
    // A COMPLETED attention closed by somebody with no authority answers «esto
    // no le toca a usted» and not «ya está cerrada»: sending a receptionist to
    // type a reason she cannot use would be the worse order.
    expect(() =>
      planClosure({
        encounter: discharged({ status: 'COMPLETED' }),
        closer: { practitionerId: SUBSTITUTE, canSignRecords: false },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(EncounterCloserNotAuthorError);
  });

  it('EN-132 rechaza cerrar una atención que todavía no tiene alta clínica', () => {
    expect(() =>
      planClosure({
        encounter: discharged({ status: 'OPEN', endedAt: null }),
        closer: { practitionerId: AUTHOR, canSignRecords: false },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(InvalidEncounterTransitionError);
  });

  it('EN-132 rechaza cerrar dos veces la misma atención', () => {
    expect(() =>
      planClosure({
        encounter: discharged({ status: 'COMPLETED' }),
        closer: { practitionerId: AUTHOR, canSignRecords: false },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(InvalidEncounterTransitionError);
  });

  it('EN-009 rechaza cerrar una atención sin condición de egreso', () => {
    /**
     * ⚠️ Y ES POR ESTO POR LO QUE NO HAY CIERRE AUTOMÁTICO (EN-145). Un
     * proceso nocturno tendría que inventarse este valor: `ALIVE` afirma que
     * el paciente salió bien de una consulta que nadie terminó, y `ABANDONED`
     * acusa al paciente de irse cuando quizá fue el médico quien salió
     * corriendo.
     */
    expect(() =>
      planClosure({
        encounter: discharged({ dischargeCondition: null }),
        closer: { practitionerId: AUTHOR, canSignRecords: false },
        to: 'COMPLETED',
        now: NOW,
      }),
    ).toThrow(DischargeConditionRequiredError);
  });

  it('EN-131 arrastra la condición de egreso declarada en el alta, sin volver a preguntarla', () => {
    // The cashier inherits the outcome the doctor declared; nobody restates it
    // and nobody invents it.
    const plan = planClosure({
      encounter: discharged({ dischargeCondition: 'REFERRED' }),
      closer: { practitionerId: AUTHOR, canSignRecords: false },
      to: 'COMPLETED',
      now: NOW,
    });

    expect(plan.dischargeCondition).toBe('REFERRED');
  });
});
