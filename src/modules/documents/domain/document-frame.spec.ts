import { describe, expect, it } from 'vitest';

import { composeFrame } from './document-frame';
import type { DocumentContext } from './document-source';
import type { DocumentTemplate } from './document-template';

/**
 * DOC-071, DOC-080 to DOC-084. The header and the footer, composed ONCE for the
 * four documents. What each document says is its own composer's business; what
 * frames it is this function's, and only this function's.
 */

const template: DocumentTemplate = {
  id: 'template-1',
  kind: 'PRESCRIPTION',
  version: 3,
  accentColour: '#0f6b5c',
  footerText: 'Atención de lunes a sábado',
  headerFields: [{ label: 'Horario', value: '08:00 a 18:00' }],
  showEstablishmentRuc: true,
  showEstablishmentAddress: true,
  showEstablishmentPhone: false,
  publishedAt: new Date('2026-08-01T12:00:00Z'), // fecha-fija: never read by the frame
};

const context: DocumentContext = {
  siteName: 'Sede Norte',
  establishment: {
    name: 'Clínica Andina',
    ruc: '1791234567001',
    addressLine: 'Av. Amazonas N34-120',
    phone: '02-2456789',
    logo: null,
    keepsAccounting: true,
    specialTaxpayerResolution: null,
    withholdingAgentResolution: null,
    rimpeRegime: 'NONE',
  },
};

describe('composeFrame', () => {
  it('DOC-080: the title comes from the kind and the reference is printed as the composer wrote it', () => {
    const frame = composeFrame(context, template, {
      kind: 'PRESCRIPTION',
      reference: 'Receta N.º 128',
      confidential: true,
      verificationCode: 'A1B2C3D4E5F60718',
    });

    expect(frame.title).toBe('RECETA MÉDICA');
    expect(frame.reference).toBe('Receta N.º 128');
    expect(frame.confidential).toBe(true);
    expect(frame.accentColour).toBe('#0f6b5c');
    expect(frame.establishmentName).toBe('Clínica Andina');
  });

  it('DOC-034, DOC-080: the header prints only what the template switches on', () => {
    const frame = composeFrame(context, template, {
      kind: 'SERVICE_ORDER',
      reference: null,
      confidential: false,
      verificationCode: null,
    });

    expect(frame.header).toEqual({
      establishmentName: 'Clínica Andina',
      establishmentRuc: '1791234567001',
      establishmentAddress: 'Av. Amazonas N34-120',
      establishmentPhone: null,
      hasLogo: false,
      fields: [{ label: 'Horario', value: '08:00 a 18:00' }],
    });
  });

  it('DOC-083: the footer carries the template text and the verification code the composer gave', () => {
    const frame = composeFrame(context, template, {
      kind: 'MEDICAL_CERTIFICATE',
      reference: null,
      confidential: false,
      verificationCode: 'CM4H8PQ2',
    });

    expect(frame.footer.text).toBe('Atención de lunes a sábado');
    expect(frame.footer.verificationCode).toBe('CM4H8PQ2');
  });

  it('DOC-083: a document without a verification code has none in its footer', () => {
    const frame = composeFrame(context, template, {
      kind: 'SERVICE_ORDER',
      reference: 'N.º 342',
      confidential: true,
      verificationCode: null,
    });

    expect(frame.footer.verificationCode).toBeNull();
  });
});
