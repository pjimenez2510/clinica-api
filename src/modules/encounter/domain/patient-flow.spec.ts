import { describe, expect, it } from 'vitest';

import { subjectStatusAfter, type TriggeringFact } from './patient-flow';
import type { PatientSubjectStatus } from './encounter';

/**
 * D-A-008, EN-134 to EN-139: the patient's progress DERIVED from what was
 * documented.
 *
 * The correspondence table of SPEC §12 is stated here, verbatim, so the code
 * cannot be its own oracle.
 */

const PRODUCES: readonly [TriggeringFact, PatientSubjectStatus][] = [
  ['VITALS_OPENED', 'IN_PREPARATION'],
  ['VITALS_RECORDED', 'READY'],
  ['NOTE_OPENED', 'RECEIVING_CARE'],
  ['NOTE_SIGNED', 'RECEIVING_CARE'],
  ['ACCOUNT_CLOSED', 'DEPARTED'],
];

describe('el avance del paciente se deriva de documentar', () => {
  it('EN-134 no ofrece ningún hecho que fije la LLEGADA, que es el único que se teclea', () => {
    /**
     * `ARRIVED` is an EXTERNAL fact — somebody walked through the door — and
     * no document proves it, so reception types it on the agenda entry. Its
     * ABSENCE from the union is the requirement: a function that could produce
     * it would be a typed way of setting the board by hand.
     */
    expect(PRODUCES.map(([, status]) => status)).not.toContain('ARRIVED');
  });

  it('EN-135 a EN-139 derivan cada estado del hecho documentado que lo prueba', () => {
    for (const [fact, expected] of PRODUCES) {
      expect(subjectStatusAfter(fact, null)).toBe(expected);
    }
  });

  it('EN-135 pone al paciente en preparación al ABRIR la toma de signos', () => {
    // Not at saving them: between the two there is a real half hour of
    // pre-consultation, and «la están preparando» told apart from «lista para
    // pasar» is the whole utility of the board.
    expect(subjectStatusAfter('VITALS_OPENED', 'ARRIVED')).toBe(
      'IN_PREPARATION',
    );
  });

  it('EN-136 lo pone LISTO al guardar los signos, sin pedir que nadie pulse nada', () => {
    expect(subjectStatusAfter('VITALS_RECORDED', 'IN_PREPARATION')).toBe(
      'READY',
    );
  });

  it('EN-137 lo pone EN ATENCIÓN al abrir la nota clínica', () => {
    expect(subjectStatusAfter('NOTE_OPENED', 'READY')).toBe('RECEIVING_CARE');
  });

  it('EN-138 lo deja EN ATENCIÓN al firmar: el médico terminó y el paciente sigue aquí', () => {
    /**
     * ⚠️ LA FILA QUE PRUEBA QUE HACEN FALTA LOS DOS EJES. La atención pasa a
     * `DISCHARGED` —el médico terminó— y la persona SIGUE EN EL EDIFICIO, en
     * caja, entre diez minutos y media hora. Con un solo eje esa media hora no
     * se puede representar: o el médico no cierra su lista hasta que cierre
     * caja, o el tablero da por ida a alguien que está en el pasillo.
     */
    // From READY — the patient went in and the doctor signed in one sitting —
    // the signature is what puts them there. From RECEIVING_CARE the board
    // already says it, and nothing is rewritten (EN-140).
    expect(subjectStatusAfter('NOTE_SIGNED', 'READY')).toBe('RECEIVING_CARE');
    expect(subjectStatusAfter('NOTE_SIGNED', 'RECEIVING_CARE')).toBeNull();
    // And they are NOT `DEPARTED`: that is the state the cashier produces.
    expect(subjectStatusAfter('NOTE_SIGNED', 'READY')).not.toBe('DEPARTED');
  });

  it('EN-139 lo marca como IDO al cerrar la cuenta', () => {
    expect(subjectStatusAfter('ACCOUNT_CLOSED', 'RECEIVING_CARE')).toBe(
      'DEPARTED',
    );
  });

  it('EN-134 nunca hace retroceder al paciente cuando un hecho llega tarde', () => {
    /**
     * THE CASE THIS EXISTS FOR: the doctor opens a second evolution note after
     * the consultation was signed, or nursing re-saves a mistyped weight half
     * an hour after the patient went in. Assigning the state each fact
     * «produces» would walk the board back — the patient reappears as `READY`
     * while they are with the doctor, and somebody calls them in a second time.
     */
    expect(subjectStatusAfter('VITALS_RECORDED', 'RECEIVING_CARE')).toBeNull();
    expect(subjectStatusAfter('VITALS_OPENED', 'READY')).toBeNull();
    expect(subjectStatusAfter('NOTE_OPENED', 'DEPARTED')).toBeNull();
  });

  it('EN-140 no reescribe el estado que el paciente ya tiene, para no reiniciar su instante', () => {
    /**
     * `null` means «write nothing», which is NOT the same as «write the state
     * it already has»: EN-140 publishes the instant the patient entered the
     * state they are in, and re-stamping it on every save would restart the
     * clock that says who is being forgotten — which is the one thing the
     * day's list is for.
     */
    expect(subjectStatusAfter('NOTE_SIGNED', 'RECEIVING_CARE')).toBeNull();
    expect(subjectStatusAfter('NOTE_OPENED', 'RECEIVING_CARE')).toBeNull();
    // And a fact that DOES move it forward still writes.
    expect(subjectStatusAfter('ACCOUNT_CLOSED', 'RECEIVING_CARE')).toBe(
      'DEPARTED',
    );
  });

  it('EN-134 deja que el siguiente hecho recoloque al paciente que había salido', () => {
    // `ON_LEAVE` sits BELOW `RECEIVING_CARE` on purpose: the patient stepped
    // out and is expected back, so the next documented act says where they now
    // are.
    expect(subjectStatusAfter('NOTE_OPENED', 'ON_LEAVE')).toBe(
      'RECEIVING_CARE',
    );
    expect(subjectStatusAfter('VITALS_RECORDED', 'ON_LEAVE')).toBeNull();
  });
});
