import { describe, expect, it } from 'vitest';

import {
  DischargeConditionRequiredError,
  EncounterAnnulmentReasonRequiredError,
  EncounterInterruptionReasonRequiredError,
  InvalidEncounterTransitionError,
} from './encounter.errors';
import {
  TERMINAL_STATUSES,
  acceptsNewClinicalContent,
  assertEncounterTransition,
  endsTheAct,
  planAnnulment,
  planInterruption,
  planStateChange,
  requiresDischargeCondition,
} from './encounter-state';
import type { EncounterStatus } from './encounter';

/**
 * The attention's state machine of SPEC §11, exhaustively and in both
 * directions: every admitted pair passes, and the WHOLE COMPLEMENT of the
 * table refuses.
 *
 * ⚠️ THE COMPLEMENT IS GENERATED AND NOT LISTED, and the spec asks for exactly
 * that: «las seis transiciones de la tabla de EN-132 se admiten y todas las
 * demás combinaciones se rechazan, generadas del producto de los cinco
 * estados. Enumerar sólo las que se recuerdan es cómo se cuela la reapertura
 * de una atención cerrada.»
 *
 * The table below is stated HERE, verbatim from the specification, so the code
 * cannot be its own oracle.
 */

const STATES: readonly EncounterStatus[] = [
  'OPEN',
  'ON_HOLD',
  'DISCONTINUED',
  'DISCHARGED',
  'COMPLETED',
  'ENTERED_IN_ERROR',
];

/** SPEC §11, EN-132, row by row. */
const ADMITTED: readonly [EncounterStatus, EncounterStatus][] = [
  ['OPEN', 'ON_HOLD'],
  ['ON_HOLD', 'OPEN'],
  ['OPEN', 'DISCONTINUED'],
  ['ON_HOLD', 'DISCONTINUED'],
  ['OPEN', 'DISCHARGED'],
  ['DISCHARGED', 'COMPLETED'],
  // EN-018. Anulling is reachable from every NON-terminal state.
  ['OPEN', 'ENTERED_IN_ERROR'],
  ['ON_HOLD', 'ENTERED_IN_ERROR'],
  ['DISCHARGED', 'ENTERED_IN_ERROR'],
];

const NOW = new Date('2026-09-14T15:00:00Z');
const EARLIER = new Date('2026-09-14T14:00:00Z');

describe('la máquina de estados de la atención', () => {
  it('EN-132 admite exactamente las transiciones de la tabla de la especificación', () => {
    for (const [from, to] of ADMITTED) {
      expect(() => assertEncounterTransition(from, to)).not.toThrow();
    }
  });

  it('EN-132 rechaza todas las demás combinaciones del producto de los seis estados', () => {
    const admitted = new Set(ADMITTED.map(([from, to]) => `${from}->${to}`));

    const accepted: string[] = [];
    for (const from of STATES) {
      for (const to of STATES) {
        if (admitted.has(`${from}->${to}`)) continue;
        try {
          assertEncounterTransition(from, to);
          accepted.push(`${from}->${to}`);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidEncounterTransitionError);
        }
      }
    }

    // Named one by one so a regression says WHICH pair got through: «reabrir
    // una cerrada» is the one that would go unnoticed in a count.
    expect(accepted).toEqual([]);
  });

  it('EN-131 no deja salir de DISCONTINUED, COMPLETED ni ENTERED_IN_ERROR', () => {
    // The three terminal states, derived from the table rather than restated:
    // a hand-kept list is the copy that stops agreeing the day somebody adds a
    // way out of one of them.
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      'COMPLETED',
      'DISCONTINUED',
      'ENTERED_IN_ERROR',
    ]);

    for (const from of TERMINAL_STATUSES) {
      for (const to of STATES) {
        expect(() => assertEncounterTransition(from, to)).toThrow(
          InvalidEncounterTransitionError,
        );
      }
    }
  });

  it('EN-132 rechaza reabrir una atención ya cerrada, que es el fallo que se busca', () => {
    // Called out on its own, above and beyond the generated complement: it is
    // the pair whose absence from a hand-written list would be invisible, and
    // a COMPLETED attention may already be invoiced and reported.
    expect(() => assertEncounterTransition('COMPLETED', 'OPEN')).toThrow(
      InvalidEncounterTransitionError,
    );
    expect(() => assertEncounterTransition('DISCHARGED', 'OPEN')).toThrow(
      InvalidEncounterTransitionError,
    );
  });

  it('EN-132 rechaza saltar de OPEN a COMPLETED sin alta clínica', () => {
    expect(() => assertEncounterTransition('OPEN', 'COMPLETED')).toThrow(
      InvalidEncounterTransitionError,
    );
  });

  it('EN-132 rechaza suspender una atención ya dada de alta', () => {
    expect(() => assertEncounterTransition('DISCHARGED', 'ON_HOLD')).toThrow(
      InvalidEncounterTransitionError,
    );
  });

  it('EN-132 nombra en español el estado en que está y qué se puede hacer desde ahí', () => {
    // EN-125: the message says what to do, not what failed internally.
    try {
      assertEncounterTransition('COMPLETED', 'OPEN');
      expect.unreachable('la transición debía rechazarse');
    } catch (error) {
      const refusal = error as InvalidEncounterTransitionError;
      expect(refusal.code).toBe('ENCOUNTER_STATE_TRANSITION_INVALID');
      expect(refusal.userTitle).toContain('Cerrada');
      expect(refusal.userTitle).toContain('ya no admite ningún cambio');
      // EN-124: nothing about the patient, and the technical message is the
      // one that reaches the logs.
      expect(refusal.message).toBe('Transition COMPLETED to OPEN is not admitted'); // prettier-ignore
    }
  });

  it('EN-126 marca como terminado el acto en los cuatro estados que llevan instante de cierre', () => {
    // The TypeScript half of `encounter_status_matches_ended_at`, stated in
    // both directions so neither can drift on its own.
    expect(STATES.filter(endsTheAct)).toEqual([
      'DISCONTINUED',
      'DISCHARGED',
      'COMPLETED',
      'ENTERED_IN_ERROR',
    ]);
    expect(STATES.filter((state) => !endsTheAct(state))).toEqual([
      'OPEN',
      'ON_HOLD',
    ]);
  });

  it('EN-009 exige condición de egreso solo en DISCHARGED y COMPLETED', () => {
    // DISCONTINUED is exempt on purpose: nothing clinical concluded, and what
    // takes its place is the written reason of EN-129.
    expect(STATES.filter(requiresDischargeCondition)).toEqual([
      'DISCHARGED',
      'COMPLETED',
    ]);
  });

  it('EN-009 rechaza dar el alta sin condición de egreso', () => {
    expect(() =>
      planStateChange({
        from: 'OPEN',
        to: 'DISCHARGED',
        endedAt: null,
        dischargeCondition: null,
        now: NOW,
      }),
    ).toThrow(DischargeConditionRequiredError);
  });

  it('EN-126 sella el instante de fin al terminar el acto', () => {
    const change = planStateChange({
      from: 'OPEN',
      to: 'DISCHARGED',
      endedAt: null,
      dischargeCondition: 'ALIVE',
      now: NOW,
    });

    expect(change).toEqual({
      to: 'DISCHARGED',
      endedAt: NOW,
      dischargeCondition: 'ALIVE',
    });
  });

  it('EN-131 conserva el instante en que terminó el acto al cerrar la cuenta', () => {
    /**
     * THE ONE THAT WOULD HAVE BEEN WRONG. `ended_at` is when the DOCTOR
     * finished — stamped when the note was signed — and settling the account
     * hours later must not move it: re-stamping it would make every attention
     * look as though the consultation had ended at the cashier's till, and
     * `ended_at` is what the RDACAA reports as the end of the consultation.
     */
    const change = planStateChange({
      from: 'DISCHARGED',
      to: 'COMPLETED',
      endedAt: EARLIER,
      dischargeCondition: 'ALIVE',
      now: NOW,
    });

    expect(change.endedAt).toEqual(EARLIER);
  });

  it('EN-128 borra el instante de fin al reanudar una atención suspendida', () => {
    // `encounter_status_matches_ended_at` is bidirectional: a live attention
    // may not carry an end instant.
    const change = planStateChange({
      from: 'ON_HOLD',
      to: 'OPEN',
      endedAt: null,
      dischargeCondition: null,
      now: NOW,
    });

    expect(change.endedAt).toBeNull();
  });

  it('EN-130 deja de admitir contenido clínico nuevo en cuanto hay alta clínica', () => {
    expect(STATES.filter(acceptsNewClinicalContent)).toEqual([
      'OPEN',
      'ON_HOLD',
    ]);
  });
});

describe('anular la atención (EN-166)', () => {
  const now = new Date();

  it.each(['OPEN', 'ON_HOLD', 'DISCHARGED'] as const)(
    'EN-166 anula desde %s con el motivo recortado, quién y cuándo',
    (from) => {
      const endedAt = from === 'DISCHARGED' ? new Date(now.getTime() - 60_000) : null; // prettier-ignore
      expect(
        planAnnulment({ from, endedAt, reason: '  Ficha equivocada ', now }),
      ).toEqual({
        to: 'ENTERED_IN_ERROR',
        endedAt: endedAt ?? now,
        reason: 'Ficha equivocada',
        at: now,
      });
    },
  );

  it('EN-166 exige motivo escrito', () => {
    expect(() =>
      planAnnulment({ from: 'OPEN', endedAt: null, reason: '   ', now }),
    ).toThrow(EncounterAnnulmentReasonRequiredError);
  });

  it.each(['DISCONTINUED', 'COMPLETED', 'ENTERED_IN_ERROR'] as const)(
    'EN-166 no anula una atención terminal (%s)',
    (from) => {
      expect(() =>
        planAnnulment({ from, endedAt: now, reason: 'x', now }),
      ).toThrow(InvalidEncounterTransitionError);
    },
  );
});

describe('interrumpir la atención (EN-167)', () => {
  const now = new Date();

  it.each(['OPEN', 'ON_HOLD'] as const)(
    'EN-167 interrumpe desde %s con motivo, origen e instante, y sin condición de egreso',
    (from) => {
      expect(
        planInterruption({
          from,
          reason: ' El paciente se retiró ',
          origin: 'PATIENT',
          now,
        }),
      ).toEqual({
        to: 'DISCONTINUED',
        endedAt: now,
        reason: 'El paciente se retiró',
        origin: 'PATIENT',
        at: now,
      });
    },
  );

  it('EN-167 exige motivo y origen, y dice cuál falta', () => {
    let missing: unknown;
    try {
      planInterruption({ from: 'OPEN', reason: ' ', origin: undefined, now });
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(EncounterInterruptionReasonRequiredError);
    expect(
      (missing as EncounterInterruptionReasonRequiredError).fieldErrors.map(
        (e) => e.field,
      ),
    ).toEqual(['reason', 'origin']);
  });

  it('EN-167 no interrumpe una atención ya dada de alta: firmó y terminó', () => {
    expect(() =>
      planInterruption({
        from: 'DISCHARGED',
        reason: 'x',
        origin: 'PATIENT',
        now,
      }),
    ).toThrow(InvalidEncounterTransitionError);
  });
});
