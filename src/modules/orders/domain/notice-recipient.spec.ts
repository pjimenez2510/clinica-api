import { describe, expect, it } from 'vitest';

import { isSelfNotice, samePersonName } from './notice-recipient';

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
});
