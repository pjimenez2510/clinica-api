import { describe, expect, it } from 'vitest';

import { composeLayout } from './document-layout';
import { templateKindOf } from './document-kind';
import { sampleSubject } from './document-samples';
import type { DocumentTemplate } from './document-template';
import type { ClinicalFormPrintData, DocumentContext } from './document-source';
import type { Block } from './page-layout';

/**
 * EN-243. Form 053 or 007, composed from its signed note: what the paper
 * says, and what it does not carry.
 */
const NOW = new Date();

const template: DocumentTemplate = {
  id: 'template-1',
  kind: 'ENCOUNTER_SUMMARY',
  version: 2,
  accentColour: '#1f6f8b',
  footerText: null,
  headerFields: [],
  showEstablishmentRuc: false,
  showEstablishmentAddress: false,
  showEstablishmentPhone: false,
  publishedAt: NOW,
};

const context: DocumentContext = {
  siteName: 'Sede Centro',
  siteLine: null,
  verificationBaseUrl: 'https://clinica.example/verificar',
  establishment: {
    name: 'Centro de Especialidades Bahía',
    ruc: '0993123456001',
    addressLine: 'Av. 9 de Octubre 123',
    headOfficeAddress: 'Av. Malecón 100, Guayaquil',
    phone: '04-2345678',
    logo: null,
    keepsAccounting: true,
    specialTaxpayerResolution: null,
    withholdingAgentResolution: null,
    rimpeRegime: 'NONE',
    tradeName: null,
    email: null,
    operatingPermit: null,
  },
};

function aForm(overrides: Partial<ClinicalFormPrintData> = {}) {
  const sample = sampleSubject('CLINICAL_FORM', NOW);
  if (sample.kind !== 'CLINICAL_FORM') throw new Error('unexpected sample');
  return {
    kind: 'CLINICAL_FORM' as const,
    data: {
      ...sample.data,
      title: 'REFERENCIA',
      sections: [
        { title: 'Establecimiento de destino', text: 'Hospital General de Chone (UNICÓDIGO 05176)' }, // prettier-ignore
        { title: 'Motivo', text: 'Dolor torácico atípico' },
      ],
      ...overrides,
    },
  };
}

function texts(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'fields':
        case 'strip':
          return block.entries.map((e) => `${e.label}=${e.value}`).join('\n');
        case 'heading':
        case 'paragraph':
          return block.text;
        case 'signature':
          return block.caption;
        default:
          return '';
      }
    })
    .join('\n');
}

describe('EN-243 el formulario 053 o 007 en papel', () => {
  it('EN-243 se titula por su acto, dice su formulario, lleva lo emitido y la firma, y no lleva código de verificación', () => {
    const layout = composeLayout(aForm(), context, template);

    expect(layout.frame.title).toBe('REFERENCIA');
    expect(layout.frame.reference).toBe('Formulario 053');
    expect(layout.frame.confidential).toBe(true);
    expect(layout.frame.footer.verification).toBeNull();

    const text = texts(layout.blocks);
    expect(text).toContain(
      'Establecimiento de destino=Hospital General de Chone (UNICÓDIGO 05176)',
    );
    expect(text).toContain('Motivo=Dolor torácico atípico');
    expect(text).toContain('Firma y sello del profesional');
    // EN-156. The constancy of how it was signed travels with the paper.
    expect(text).toContain('sin certificado de firma electrónica');
    expect(text).not.toContain('ANULADA');
  });

  it('EN-107 EN-243 el de un acto anulado lo dice en el título y en el cuerpo', () => {
    const layout = composeLayout(
      aForm({ annulled: true, title: 'INTERCONSULTA', formCode: '007' }),
      context,
      template,
    );

    expect(layout.frame.title).toBe('INTERCONSULTA (ANULADA)');
    expect(layout.frame.reference).toBe('Formulario 007');
    expect(texts(layout.blocks)).toContain('ANULADA');
  });

  it('EN-243 usa la plantilla del resumen de la atención', () => {
    expect(templateKindOf('CLINICAL_FORM')).toBe('ENCOUNTER_SUMMARY');
  });
});
