import { describe, expect, it } from 'vitest';

import { DOCUMENT_KINDS } from './document-kind';
import { SAMPLE_MARK, sampleSubject } from './document-samples';

/** DOC-038. The preview's content is invented, and says so. */
describe('sampleSubject', () => {
  const issuedAt = new Date();

  it.each(DOCUMENT_KINDS)(
    'DOC-038 compone una muestra de %s con el instante que recibe',
    (kind) => {
      const subject = sampleSubject(kind, issuedAt);
      expect(subject.kind).toBe(kind);
      expect(JSON.stringify(subject)).toContain('MUESTRA');
    },
  );

  it('DOC-038 el paciente de muestra no es nadie: lo dice su nombre', () => {
    const subject = sampleSubject('PRESCRIPTION', issuedAt);
    if (subject.kind !== 'PRESCRIPTION') throw new Error('unexpected kind');
    expect(subject.data.patient.fullName).toContain('MUESTRA');
    expect(subject.data.issuedAt).toBe(issuedAt);
    expect(SAMPLE_MARK).toBe('MUESTRA SIN VALIDEZ');
  });
});
