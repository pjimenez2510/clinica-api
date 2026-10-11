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
  namesOrderingPractitioner: false,
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
      patientRequired: true,
      missingRecipients: ['PATIENT'],
      proposedRecipient: {
        recipientKind: 'PATIENT',
        recipientName: 'Rosa Chicaiza',
      },
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
    // Control positivo: si cambia la unidad de un valor crítico avisado, sí.
    const unit = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 25, { unit: 'mmol/L', abnormalFlag: 'HIGH' })],
      ),
    );
    expect(unit.get('b')?.told.valueNumeric).toBe(25);
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
    // La nota del médico para sí: un aviso a un PACIENTE nunca es «sólo el
    // médico lo supo» (ORD-171, revisión clínica G1).
    const own = (id: string) =>
      notice({ recipientKind: 'ORDERING_PRACTITIONER', selfNotice: true, notifiedBy: { id } }); // prettier-ignore
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

describe('la corrección que tiene que llegar a quien se avisó (D-156)', () => {
  it('ORD-153 si se avisó al paciente, sólo un aviso de la corrección al paciente o a su representante la cierra', () => {
    const toPatient = notice({ recipientKind: 'PATIENT' });
    const onCall = notice({ recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Dra. Guardia' }); // prettier-ignore
    const open = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [onCall] })],
      ),
    );
    expect(open.get('b')).toMatchObject({ due: true, patientRequired: true });
    for (const recipientKind of ['PATIENT', 'REPRESENTATIVE']) {
      const closed = notifiedCorrections(
        chain(
          [glucose('a', 25, { notices: [toPatient] })],
          [glucose('b', 95, { notices: [notice({ recipientKind })] })],
        ),
      );
      expect(closed.get('b')?.due).toBe(false);
    }
  });

  it('ORD-153 sin aviso anterior al paciente basta cualquiera; un autoaviso con nombre de paciente no lo pide', () => {
    const onCall = notice({ recipientKind: 'OTHER_PRACTITIONER' });
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [onCall] })],
        [glucose('b', 95, { notices: [notice({ recipientKind: 'ORDERING_PRACTITIONER' })] })], // prettier-ignore
      ),
    );
    expect(found.get('b')).toMatchObject({
      due: false,
      patientRequired: false,
    });
    const self = notice({ recipientKind: 'PATIENT', selfNotice: true, notifiedBy: { id: 'doctor' } }); // prettier-ignore
    const own = notifiedCorrections(
      chain([glucose('a', 25, { notices: [self] })], [glucose('b', 95)]),
    );
    expect(own.get('b')?.patientRequired).toBe(false);
  });

  it('ORD-153 la corrección pendiente que se hereda sigue pidiendo al paciente', () => {
    const self = notice({ selfNotice: true, recipientKind: 'ORDERING_PRACTITIONER', notifiedBy: { id: 'doctor' } }); // prettier-ignore
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [notice()] })],
        [glucose('b', 95, { notices: [self] })],
        [glucose('c', 95, { notices: [notice({ recipientKind: 'OTHER_PRACTITIONER' })] })], // prettier-ignore
      ),
    );
    expect(found.get('c')).toMatchObject({ due: true, patientRequired: true, told: { valueNumeric: 25 } }); // prettier-ignore
  });

  it('ORD-156 con valor anterior avisado no crítico, la corrección sólo vuelve si cambia la bandera', () => {
    const told = [
      [glucose('a', 25, { notices: [notice()] })],
      [glucose('b', 95, { notices: [notice()] })],
    ];
    // 95 avisado de la corrección → 97: sigue normal.
    expect(notifiedCorrections(chain(...told, [glucose('c', 97)])).has('c')).toBe(false); // prettier-ignore
    expect(notifiedCorrections(chain(...told, [glucose('c', 5.3, { unit: 'mmol/L' })])).has('c')).toBe(false); // prettier-ignore
    // Control positivo: a 130, alto, sí, y de lo que se dijo: el 95.
    const high = notifiedCorrections(chain(...told, [glucose('c', 130, { abnormalFlag: 'HIGH' })])); // prettier-ignore
    expect(high.get('c')).toMatchObject({ due: true, told: { valueNumeric: 95, abnormalFlag: 'NORMAL' } }); // prettier-ignore
  });

  it('ORD-156 sin bandera en alguno de los dos, se juzga por lo escrito', () => {
    const told = [
      [glucose('a', 25, { notices: [notice()] })],
      [glucose('b', 95, { abnormalFlag: null, notices: [notice()] })],
    ];
    expect(notifiedCorrections(chain(...told, [glucose('c', 97, { abnormalFlag: null })])).has('c')).toBe(true); // prettier-ignore
    expect(notifiedCorrections(chain(...told, [glucose('c', 97)])).has('c')).toBe(true); // prettier-ignore
    expect(notifiedCorrections(chain(...told, [glucose('c', 95, { abnormalFlag: null })])).has('c')).toBe(false); // prettier-ignore
  });
});

describe('la corrección llega a cada tipo de persona que recibió el valor falso (D-168)', () => {
  const daughter = notice({ recipientKind: 'REPRESENTATIVE', recipientName: 'Hija' }); // prettier-ignore
  const onCall = notice({ recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Dra. Lucía Guardia' }); // prettier-ignore
  const toPatient = notice({ recipientKind: 'PATIENT', recipientName: 'Rosa Chicaiza' }); // prettier-ignore

  it('ORD-171 con la paciente y la guardia avisadas, avisar sólo a la hija no la cierra; avisar también a un profesional sí', () => {
    const open = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [daughter] })],
      ),
      'doctor',
    );
    expect(open.get('b')).toMatchObject({ due: true, missingRecipients: ['PRACTITIONER'] }); // prettier-ignore
    // Control positivo: con el aviso a la guardia, se cierra.
    const closed = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [daughter, onCall] })],
      ),
      'doctor',
    );
    expect(closed.get('b')).toMatchObject({ due: false, missingRecipients: [] }); // prettier-ignore
    // El autoaviso de quien registra no cuenta como el profesional.
    const self = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [daughter, notice({ recipientKind: 'OTHER_PRACTITIONER', selfNotice: true })] })], // prettier-ignore
      ),
      'doctor',
    );
    expect(self.get('b')?.due).toBe(true);
  });

  it('ORD-171 si todo lo anterior fue al médico que pidió, su propio aviso de la corrección la cierra', () => {
    // D-168 §5: la enfermera avisó del 25 al médico; la paciente nunca lo oyó.
    const toOrderer = notice({ recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Dr. Juan Pérez' }); // prettier-ignore
    const byName = notice({ recipientKind: 'OTHER_PRACTITIONER', namesOrderingPractitioner: true }); // prettier-ignore
    const own = (id: string) =>
      notice({ recipientKind: 'ORDERING_PRACTITIONER', selfNotice: true, notifiedBy: { id } }); // prettier-ignore
    for (const earlier of [toOrderer, byName]) {
      const closed = notifiedCorrections(
        chain(
          [glucose('a', 25, { notices: [earlier] })],
          [glucose('b', 95, { notices: [own('doctor')] })],
        ),
        'doctor',
      );
      expect(closed.get('b')?.due).toBe(false);
    }
    // Control positivo: el autoaviso de otra cuenta no la cierra, y con la
    // paciente avisada antes tampoco basta el del médico.
    const colleague = notifiedCorrections(
      chain([glucose('a', 25, { notices: [toOrderer] })], [glucose('b', 95, { notices: [own('colleague')] })]), // prettier-ignore
      'doctor',
    );
    expect(colleague.get('b')?.due).toBe(true);
    const patientToo = notifiedCorrections(
      chain([glucose('a', 25, { notices: [toOrderer, toPatient] })], [glucose('b', 95, { notices: [own('doctor')] })]), // prettier-ignore
      'doctor',
    );
    expect(patientToo.get('b')).toMatchObject({ due: true, missingRecipients: ['PATIENT', 'PRACTITIONER'] }); // prettier-ignore
  });

  it('ORD-172 propone a quien recibió el aviso, el paciente primero', () => {
    const both = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [onCall, toPatient] })],
        [glucose('b', 95)],
      ),
      'doctor',
    );
    expect(both.get('b')).toMatchObject({
      missingRecipients: ['PATIENT', 'PRACTITIONER'],
      proposedRecipient: { recipientKind: 'PATIENT', recipientName: 'Rosa Chicaiza' }, // prettier-ignore
    });
    // Con la paciente ya avisada de la corrección, propone a la guardia.
    const onlyOnCall = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [onCall, toPatient] })],
        [glucose('b', 95, { notices: [toPatient] })],
      ),
      'doctor',
    );
    expect(onlyOnCall.get('b')?.proposedRecipient).toEqual({
      recipientKind: 'OTHER_PRACTITIONER',
      recipientName: 'Dra. Lucía Guardia',
    });
  });

  it('ORD-171 un aviso a la paciente cuenta siempre como que la paciente oyó el valor falso, aunque su nombre contenga el del médico o el de quien registra', () => {
    // Revisión clínica G1: «Juan Carlos Pérez Andrade» contiene «Juan Pérez».
    const toPatientNamedLikeDoctor = notice({ recipientKind: 'PATIENT', recipientName: 'Juan Carlos Pérez Andrade', namesOrderingPractitioner: true }); // prettier-ignore
    const toPatientJudgedSelf = notice({ recipientKind: 'PATIENT', recipientName: 'María José Pérez Andrade', selfNotice: true }); // prettier-ignore
    const own = notice({ recipientKind: 'ORDERING_PRACTITIONER', selfNotice: true, notifiedBy: { id: 'doctor' } }); // prettier-ignore
    for (const earlier of [toPatientNamedLikeDoctor, toPatientJudgedSelf]) {
      const found = notifiedCorrections(
        chain([glucose('a', 25, { notices: [earlier] })], [glucose('b', 95, { notices: [own] })]), // prettier-ignore
        'doctor',
      );
      expect(found.get('b')).toMatchObject({ due: true, missingRecipients: ['PATIENT'] }); // prettier-ignore
    }
  });

  it('ORD-171 lo avisado de una corrección intermedia no cuenta como aviso del valor falso', () => {
    // Revisión de código M1: 25 a la paciente y a la guardia; 95 sólo a la
    // paciente; el laboratorio reescribe el 95 al corregir otra cosa.
    const found = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [{ ...toPatient }] })],
        [glucose('c', 95)],
      ),
      'doctor',
    );
    expect(found.get('c')).toMatchObject({ due: true, told: { valueNumeric: 25 }, missingRecipients: ['PRACTITIONER'] }); // prettier-ignore
    // Control positivo: avisada también la guardia sobre el 95, se cierra.
    const closed = notifiedCorrections(
      chain(
        [glucose('a', 25, { notices: [toPatient, onCall] })],
        [glucose('b', 95, { notices: [{ ...toPatient }] })],
        [glucose('c', 95, { notices: [{ ...onCall }] })],
      ),
      'doctor',
    );
    expect(closed.get('c')?.due).toBe(false);
  });
});
