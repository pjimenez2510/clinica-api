import { describe, expect, it } from 'vitest';

import { DOCUMENT_KINDS } from './document-kind';
import { composeLayout } from './document-layout';
import { SAMPLE_MARK, sampleSubject } from './document-samples';
import type { DocumentContext } from './document-source';
import type { DocumentTemplate } from './document-template';

const sampleContext: DocumentContext = {
  siteName: 'Sede de ejemplo',
  siteLine: null,
  verificationBaseUrl: 'https://clinica.example/verificar',
  establishment: {
    name: 'Clínica de ejemplo',
    tradeName: null,
    email: null,
    operatingPermit: null,
    ruc: null,
    addressLine: null,
    phone: null,
    logo: null,
    keepsAccounting: false,
    specialTaxpayerResolution: null,
    withholdingAgentResolution: null,
    rimpeRegime: 'NONE',
  },
};

const sampleTemplate: DocumentTemplate = {
  id: 'sample',
  kind: 'PRESCRIPTION',
  version: 1,
  publishedAt: new Date(),
  accentColour: '#0f6b5c',
  footerText: null,
  headerFields: [],
  showEstablishmentRuc: false,
  showEstablishmentAddress: false,
  showEstablishmentPhone: false,
};

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

describe('la receta de muestra', () => {
  it('DOC-074 la muestra imprime la vía con su nombre: su código existe en el sistema', () => {
    const layout = composeLayout(
      sampleSubject('PRESCRIPTION', new Date()),
      sampleContext,
      sampleTemplate,
    );
    expect(JSON.stringify(layout.blocks)).toContain('Vía oral');
  });
});
