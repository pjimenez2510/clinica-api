import { describe, expect, it } from 'vitest';

import { sampleSubject } from './document-samples';
import type { DocumentSubject } from './document-source';
import { supersedeReasonOf } from './document-supersession';

/**
 * DOC-108, DOC-109. The reason the system writes on a corrected PDF, from the
 * state of what it represents. Every instant comes from the run's clock.
 */
const now = new Date();

const prescription = (status: string): DocumentSubject => {
  const subject = sampleSubject('PRESCRIPTION', now);
  if (subject.kind !== 'PRESCRIPTION') throw new Error('sample');
  return { ...subject, data: { ...subject.data, status, sequenceNumber: 12 } };
};

const order = (statuses: string[]): DocumentSubject => {
  const subject = sampleSubject('SERVICE_ORDER', now);
  if (subject.kind !== 'SERVICE_ORDER') throw new Error('sample');
  const [line] = subject.data.items;
  return {
    ...subject,
    data: {
      ...subject.data,
      number: 5,
      items: statuses.map((status) => ({ ...line!, status })),
    },
  };
};

const certificate = (revoked: boolean): DocumentSubject => {
  const subject = sampleSubject('MEDICAL_CERTIFICATE', now);
  if (subject.kind !== 'MEDICAL_CERTIFICATE') throw new Error('sample');
  return {
    ...subject,
    data: {
      ...subject.data,
      form: {
        ...subject.data.form,
        number: 3,
        revocation: revoked
          ? { revokedAt: now, revokedOn: '2026-01-01' as never, reason: 'x' } // fecha-fija: sólo importa que exista la anulación
          : null,
      },
    },
  };
};

describe('DOC-108 el motivo de corregir un PDF lo pone el sistema', () => {
  it('DOC-108 sin causa conocida es «Nueva versión del documento» (control positivo)', () => {
    expect(supersedeReasonOf(prescription('ACTIVE'), 'AUTOMATIC')).toBe(
      'Nueva versión del documento',
    );
    expect(supersedeReasonOf(order(['REQUESTED']), 'AUTOMATIC')).toBe(
      'Nueva versión del documento',
    );
    expect(supersedeReasonOf(certificate(false), 'AUTOMATIC')).toBe(
      'Nueva versión del documento',
    );
  });

  it('DOC-108 una receta anulada, un examen anulado y un certificado anulado dicen su causa', () => {
    expect(supersedeReasonOf(prescription('CANCELLED'), 'AUTOMATIC')).toBe(
      'Receta anulada',
    );
    expect(
      supersedeReasonOf(order(['REQUESTED', 'CANCELLED']), 'AUTOMATIC'),
    ).toBe('Examen anulado');
    expect(supersedeReasonOf(certificate(true), 'AUTOMATIC')).toBe(
      'Certificado anulado',
    );
  });

  it('DOC-109 una corrección dice el número de lo que se corrigió', () => {
    expect(supersedeReasonOf(prescription('CANCELLED'), 'CORRECTION')).toBe(
      'Corrección de la receta N.º 12',
    );
    expect(supersedeReasonOf(order(['CANCELLED']), 'CORRECTION')).toBe(
      'Corrección de la orden N.º 5',
    );
    expect(supersedeReasonOf(certificate(true), 'CORRECTION')).toBe(
      'Corrección del certificado N.º 3',
    );
  });
});
