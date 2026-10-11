import { describe, expect, it } from 'vitest';

import {
  closesCriticalWorklist,
  isSelfNotice,
  namesPerson,
  selfNoticedByOrderer,
  type WorklistNotice,
} from './notice-recipient';

const DOCTOR = { userId: 'doctor', name: 'Juan Pérez Andrade' };
const NURSE = { userId: 'nurse', name: 'María Quishpe' };

describe('el destinatario de un aviso', () => {
  it('ORD-147 reconoce el mismo nombre sin mayúsculas, tildes, espacios ni tratamiento inicial', () => {
    expect(namesPerson('  dr. juan  PEREZ andrade ', 'Juan Pérez Andrade')).toBe(true); // prettier-ignore
    expect(namesPerson('Dra. María Quishpe', 'Maria Quishpe')).toBe(true);
    expect(namesPerson('Lcda Maria Quishpe', 'María Quishpe')).toBe(true);
  });

  it('ORD-147 no reconoce un nombre a medias ni uno vacío', () => {
    expect(namesPerson('Dr. Pérez', 'Juan Pérez Andrade')).toBe(false);
    expect(namesPerson('Juan Pérez', 'Juan Pérez Andrade')).toBe(false);
    expect(namesPerson('', '')).toBe(false);
    expect(namesPerson('Dr.', 'Dr.')).toBe(false);
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

describe('el nombre como conjunto de palabras y quien llamó (D-156)', () => {
  it('ORD-157 reconoce las mismas palabras en cualquier orden, como en la cédula', () => {
    expect(namesPerson('Pérez Andrade Juan', 'Juan Pérez Andrade')).toBe(true); // prettier-ignore
    expect(namesPerson('Dr. ANDRADE juan  perez', 'Juan Pérez Andrade')).toBe(true); // prettier-ignore
    // Con la coma de «apellidos, nombres» también.
    expect(namesPerson('Pérez Andrade, Juan', 'Juan Pérez Andrade')).toBe(true); // prettier-ignore
    // Control positivo: con una palabra de menos no la nombra.
    expect(namesPerson('Pérez Juan', 'Juan Pérez Andrade')).toBe(false);
    expect(namesPerson('Pérez Andrade', 'Juan Pérez Andrade')).toBe(false);
  });

  it('ORD-174 una palabra de más no esquiva el nombre: «Carmen Salazar Pilco» nombra a «Carmen Salazar»', () => {
    // D-168 §4: ante la duda el valor se queda en la cola, el error seguro.
    expect(namesPerson('Carmen Salazar Pilco', 'Carmen Salazar')).toBe(true);
    expect(namesPerson('Lcda. Pilco Salazar, Carmen Elena', 'Carmen Salazar')).toBe(true); // prettier-ignore
    // Cada palabra cuenta las veces que se escribe.
    expect(namesPerson('Juan Juan Pérez', 'Juan Pérez')).toBe(true);
    expect(namesPerson('Juan Pérez', 'Juan Juan Pérez')).toBe(false);
    // Control positivo: un nombre a medias sigue sin contener a la persona.
    expect(namesPerson('Dr. Salazar', 'Carmen Salazar')).toBe(false);
  });

  it('ORD-174 es autoaviso el destinatario que contiene el nombre de la cuenta, o el de quien llamó', () => {
    const carmen = { userId: 'carmen', name: 'Carmen Salazar' };
    const toHerself = { recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Dra. Carmen Salazar Pilco', recorder: carmen, orderedByUserId: 'doctor' }; // prettier-ignore
    expect(isSelfNotice(toHerself)).toBe(true);
    // Quien llamó con su nombre completo es ella misma: se juzga con su cuenta.
    expect(isSelfNotice({ ...toHerself, callerName: 'Carmen Salazar Pilco' })).toBe(true); // prettier-ignore
    // Otra persona que llama y se nombra a sí misma como destinataria, con una palabra de más.
    expect(isSelfNotice({ ...toHerself, recorder: NURSE, callerName: 'Carmen Salazar' })).toBe(true); // prettier-ignore
    // Control positivo: a otra persona, no.
    expect(isSelfNotice({ ...toHerself, recipientName: 'Ana Toapanta' })).toBe(false); // prettier-ignore
  });

  it('ORD-155 con quien llamó, que no es quien registra, el autoaviso se juzga con quien llamó', () => {
    // «La enfermera me llamó a mí»: el médico que pidió lo registra a su nombre.
    const toMe = { recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Juan Pérez Andrade', recorder: DOCTOR, orderedByUserId: 'doctor' }; // prettier-ignore
    expect(isSelfNotice({ ...toMe, callerName: 'Lcda. María Quishpe' })).toBe(false); // prettier-ignore
    expect(isSelfNotice({ ...toMe, recipientKind: 'OTHER_PRACTITIONER', callerName: 'María Quishpe' })).toBe(false); // prettier-ignore
    // Control positivo: sin quien llamó, o si quien llamó es la propia cuenta, sí lo es.
    expect(isSelfNotice(toMe)).toBe(true);
    expect(isSelfNotice({ ...toMe, callerName: 'Pérez Andrade Juan' })).toBe(
      true,
    );
    // Y quien llamó a sí mismo no avisó a nadie.
    expect(isSelfNotice({ ...toMe, recorder: NURSE, callerName: 'Dr. Juan Pérez Andrade' })).toBe(true); // prettier-ignore
    // Quien llamó escrito sólo con un tratamiento no nombra a nadie: se juzga con quien registra.
    expect(isSelfNotice({ ...toMe, callerName: 'Dr.' })).toBe(true);
    expect(isSelfNotice({ ...toMe, callerName: ' Lcda. ' })).toBe(true);
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
