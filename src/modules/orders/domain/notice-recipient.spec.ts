import { describe, expect, it } from 'vitest';

import {
  closesCriticalWorklist,
  isSelfNotice,
  samePersonName,
  selfNoticedByOrderer,
  type WorklistNotice,
} from './notice-recipient';

const DOCTOR = { userId: 'doctor', name: 'Juan Pérez Andrade' };
const NURSE = { userId: 'nurse', name: 'María Quishpe' };

describe('el destinatario de un aviso', () => {
  it('ORD-147 reconoce el mismo nombre sin mayúsculas, tildes, espacios ni tratamiento inicial', () => {
    expect(samePersonName('  dr. juan  PEREZ andrade ', 'Juan Pérez Andrade')).toBe(true); // prettier-ignore
    expect(samePersonName('Dra. María Quishpe', 'Maria Quishpe')).toBe(true);
    expect(samePersonName('Lcda Maria Quishpe', 'María Quishpe')).toBe(true);
  });

  it('ORD-147 no reconoce un nombre a medias ni uno vacío', () => {
    expect(samePersonName('Dr. Pérez', 'Juan Pérez Andrade')).toBe(false);
    expect(samePersonName('Juan Pérez', 'Juan Pérez Andrade')).toBe(false);
    expect(samePersonName('', '')).toBe(false);
    expect(samePersonName('Dr.', 'Dr.')).toBe(false);
  });

  it('ORD-062 el aviso «al médico que pidió» que registra ese médico es un autoaviso, escriba el nombre que escriba', () => {
    const question = { recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Dr. Andrade', orderedByUserId: 'doctor' }; // prettier-ignore
    expect(isSelfNotice({ ...question, recorder: DOCTOR })).toBe(true);
    // Control positivo: el mismo aviso registrado por la enfermera no lo es.
    expect(isSelfNotice({ ...question, recorder: NURSE })).toBe(false);
  });

  it('ORD-147 es autoaviso todo aviso cuyo destinatario lleva el nombre de quien lo registra, sea cual sea su tipo', () => {
    for (const recipientKind of [
      'OTHER_PRACTITIONER',
      'PATIENT',
      'REPRESENTATIVE',
    ]) {
      expect(isSelfNotice({ recipientKind, recipientName: 'Dr. Juan Perez Andrade', recorder: DOCTOR, orderedByUserId: 'someone-else' })).toBe(true); // prettier-ignore
    }
    // Control positivo: el nombre de otra persona no lo es.
    expect(isSelfNotice({ recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Ana Toapanta', recorder: DOCTOR, orderedByUserId: 'doctor' })).toBe(false); // prettier-ignore
  });

  it('ORD-148 un aviso cuyo destinatario es quien hizo la llamada es un autoaviso, lo registre quien lo registre', () => {
    expect(isSelfNotice({ recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Juan Pérez Andrade', callerName: 'Dr. Juan Perez Andrade', recorder: NURSE, orderedByUserId: 'doctor' })).toBe(true); // prettier-ignore
    expect(isSelfNotice({ recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Juan Pérez Andrade', callerName: 'María Quishpe', recorder: NURSE, orderedByUserId: 'doctor' })).toBe(false); // prettier-ignore
  });
});

describe('el cierre de la cola de críticos (ORD-146)', () => {
  const NOW = new Date();
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const n = (o: Partial<WorklistNotice>): WorklistNotice => ({ outcome: 'NOTIFIED', selfNotice: false, recipientKind: 'PATIENT', namesOrderingPractitioner: false, notifiedById: 'nurse', notifiedAt: at(30), ...o }); // prettier-ignore
  const ownNote = n({ selfNotice: true, recipientKind: 'ORDERING_PRACTITIONER', notifiedById: 'doctor', notifiedAt: at(60) }); // prettier-ignore

  it('ORD-146 tras el autoaviso del médico, el aviso al médico —por tipo o por nombre— no cierra; al paciente sí', () => {
    expect(closesCriticalWorklist([ownNote, n({ recipientKind: 'ORDERING_PRACTITIONER' })], 'doctor')).toBe(false); // prettier-ignore
    expect(closesCriticalWorklist([ownNote, n({ recipientKind: 'OTHER_PRACTITIONER', namesOrderingPractitioner: true })], 'doctor')).toBe(false); // prettier-ignore
    expect(closesCriticalWorklist([ownNote, n({})], 'doctor')).toBe(true);
  });

  it('ORD-146 el aviso al médico ANTERIOR a su autoaviso sigue cerrando, y el autoaviso de otra cuenta no cambia el destino', () => {
    const earlier = n({ recipientKind: 'ORDERING_PRACTITIONER', notifiedAt: at(90) }); // prettier-ignore
    expect(closesCriticalWorklist([earlier, ownNote], 'doctor')).toBe(true);
    const colleague = n({ selfNotice: true, notifiedById: 'colleague', notifiedAt: at(60) }); // prettier-ignore
    expect(selfNoticedByOrderer([colleague], 'doctor')).toBe(false);
    expect(closesCriticalWorklist([colleague, n({ recipientKind: 'ORDERING_PRACTITIONER' })], 'doctor')).toBe(true); // prettier-ignore
    expect(selfNoticedByOrderer([ownNote], 'doctor')).toBe(true);
  });
});
