import { describe, expect, it } from 'vitest';

import {
  notifiedCorrections,
  type StatedNotice,
  type StatedResult,
  type StatedVersion,
} from './notified-correction';

/**
 * ORD-143 (D-115). The clock is a parameter: every instant derives from NOW.
 */
const NOW = new Date();
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const notice = (overrides: Partial<StatedNotice> = {}): StatedNotice => ({
  notifiedBy: { id: 'nurse' },
  recipientKind: 'PATIENT',
  recipientName: 'Paciente',
  notifiedAt: minutesAgo(90),
  outcome: 'NOTIFIED',
  selfNotice: false,
  ...overrides,
});

const glucose = (
  id: string,
  value: number,
  overrides: Partial<StatedResult> = {},
): StatedResult => ({
  id,
  analyteDisplay: 'Glucosa',
  valueNumeric: value,
  valueCode: null,
  valueText: null,
  unit: 'mg/dL',
  abnormalFlag: value < 40 ? 'CRITICAL_LOW' : 'NORMAL',
  observedAt: minutesAgo(120),
  notices: [],
  ...overrides,
});

/** A chain, oldest first: each version replaces the one before it. */
function chain(...versions: StatedResult[][]): StatedVersion[] {
  return versions.map((results, index) => ({
    id: `r${index}`,
    supersedesId: index === 0 ? null : `r${index - 1}`,
    supersededById: index === versions.length - 1 ? null : `r${index + 1}`,
    supersededRecordedAt:
      index === versions.length - 1 ? null : minutesAgo(60 - index),
    results,
  }));
}

describe('la corrección de un valor avisado', () => {
  it('ORD-143 un 25 avisado al paciente y corregido a 95 espera el aviso de la corrección, con lo que se dijo', () => {
    const told = notice({ recipientName: 'Rosa Chicaiza' });
    const found = notifiedCorrections(
      chain([glucose('a', 25, { notices: [told] })], [glucose('b', 95)]),
    );
    expect(found.get('b')).toEqual({
      resultId: 'b',
      told: {
        valueNumeric: 25,
        valueCode: null,
        valueText: null,
        unit: 'mg/dL',
        abnormalFlag: 'CRITICAL_LOW',
        observedAt: minutesAgo(120),
      },
      earlierNotices: [told],
      correctedAt: minutesAgo(60),
      due: true,
      standing: true,
    });
    // La versión que avisó no corrige nada.
    expect(found.has('a')).toBe(false);
  });

  it('ORD-143 sin aviso hecho no hay nada que comunicar: ni un intento sin respuesta lo pide', () => {
    expect(notifiedCorrections(chain([glucose('a', 25)], [glucose('b', 95)])).size).toBe(0); // prettier-ignore
    const attempt = notice({ outcome: 'NO_ANSWER' });
    expect(notifiedCorrections(chain([glucose('a', 25, { notices: [attempt] })], [glucose('b', 95)])).size).toBe(0); // prettier-ignore
  });

  it('ORD-143 la corrección que sigue siendo crítica no entra: espera en la cola de críticos', () => {
    const found = notifiedCorrections(
      chain([glucose('a', 25, { notices: [notice()] })], [glucose('b', 22)]),
    );
    expect(found.size).toBe(0);
  });

  it('ORD-143 el valor que la corrección vuelve a escribir igual no se comunica', () => {
    // 25 avisado → 95 avisado de la corrección → el laboratorio corrige otra
    // cosa y vuelve a escribir el 95.
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [notice()] })],
        [glucose('c', 95)],
      ),
    );
    expect(found.has('c')).toBe(false);
    // Control positivo: si cambia la unidad, sí.
    const unit = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [notice()] })],
        [glucose('c', 95, { unit: 'mmol/L' })],
      ),
    );
    expect(unit.get('c')?.told.valueNumeric).toBe(95);
  });

  it('ORD-143 un aviso hecho de la corrección la cierra; uno sin respuesta, no', () => {
    const open = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [notice({ outcome: 'NO_ANSWER' })] })],
      ),
    );
    expect(open.get('b')?.due).toBe(true);
    const closed = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [notice()] })],
      ),
    );
    expect(closed.get('b')?.due).toBe(false);
  });

  it('ORD-143 si se avisó a alguien más, el autoaviso de la corrección no la cierra', () => {
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice(), notice({ selfNotice: true })] })], // prettier-ignore
        [glucose('b', 95, { notices: [notice({ selfNotice: true })] })],
      ),
    );
    expect(found.get('b')?.due).toBe(true);
  });

  it('ORD-143 si sólo el médico se lo anotó, su propia constancia de la corrección la cierra', () => {
    const self = notice({ selfNotice: true, recipientKind: 'ORDERING_PRACTITIONER', notifiedBy: { id: 'doctor' } }); // prettier-ignore
    const pending = notifiedCorrections(
      chain([glucose('a', 25, { notices: [self] })], [glucose('b', 95)]),
    );
    expect(pending.get('b')?.due).toBe(true);
    const closed = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [self] })],
        [glucose('b', 95, { notices: [self] })],
      ),
    );
    expect(closed.get('b')?.due).toBe(false);
  });

  it('ORD-143 dos correcciones seguidas sin aviso entre ellas comparan con el último valor avisado', () => {
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95)],
        [glucose('c', 97)],
      ),
    );
    expect(found.get('c')?.told.valueNumeric).toBe(25);
    // El 95, ya sustituido, también corrige el 25: la llamada hecha mientras
    // estaba vigente se puede anotar (ORD-144); sólo el 97 espera en la cola.
    expect(found.get('b')?.standing).toBe(false);
    expect(found.get('c')?.standing).toBe(true);
    // El 25 dejó de ser cierto con la primera corrección.
    expect(found.get('c')?.correctedAt).toEqual(minutesAgo(60));
  });

  it('ORD-143 un autoaviso que no cerró la corrección no la da por avisada cuando otra corrección reescribe el mismo valor', () => {
    const self = notice({ selfNotice: true, notifiedBy: { id: 'doctor' } });
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [self] })],
        [glucose('c', 95)],
      ),
    );
    // Sigue esperando, y de lo que se le dijo al paciente: el 25.
    expect(found.get('c')).toMatchObject({ due: true, standing: true, told: { valueNumeric: 25 } }); // prettier-ignore
    // Control positivo: si el 95 se avisó de verdad, reescribirlo no pide nada.
    const told = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [notice()] })],
        [glucose('c', 95)],
      ),
    );
    expect(told.has('c')).toBe(false);
  });

  it('ORD-143 el autoaviso de otra cuenta no cierra la corrección que sólo anotó el médico que pidió', () => {
    const own = (id: string) =>
      notice({ selfNotice: true, notifiedBy: { id } });
    const other = notifiedCorrections(
      chain([glucose('a', 25, { notices: [own('doctor')] })], [glucose('b', 95, { notices: [own('colleague')] })]), // prettier-ignore
    );
    expect(other.get('b')?.due).toBe(true);
    const same = notifiedCorrections(
      chain([glucose('a', 25, { notices: [own('doctor')] })], [glucose('b', 95, { notices: [own('doctor')] })]), // prettier-ignore
    );
    expect(same.get('b')?.due).toBe(false);
  });
});
