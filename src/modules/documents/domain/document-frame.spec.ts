import { describe, expect, it } from 'vitest';

import { composeFrame, type FrameRequest } from './document-frame';
import type { DocumentContext } from './document-source';
import type { DocumentTemplate } from './document-template';
import type { DocumentHeader } from './page-layout';

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
  siteLine: null,
  verificationBaseUrl: 'https://clinica.example/verificar',
  establishment: {
    name: 'CLÍNICA ANDINA CLIANDINA S.A.',
    tradeName: 'Clínica Andina',
    email: 'contacto@example.com',
    operatingPermit: 'ACESS-2026-0456',
    ruc: '1791234567001',
    addressLine: 'Av. Amazonas N34-120',
    headOfficeAddress: null,
    phone: '02-2456789',
    logo: null,
    keepsAccounting: true,
    specialTaxpayerResolution: null,
    withholdingAgentResolution: null,
    rimpeRegime: 'NONE',
  },
};

const prescription: FrameRequest = {
  kind: 'PRESCRIPTION',
  reference: 'Receta N.º 128',
  confidential: true,
  verificationCode: 'A1B2C3D4E5F60718',
};

function headerOf(
  frameContext: DocumentContext,
  request: FrameRequest = prescription,
): DocumentHeader {
  const header = composeFrame(frameContext, template, request).header;
  if (header === null) throw new Error('expected a header');
  return header;
}

describe('composeFrame', () => {
  it('DOC-080 el título sale de la clase y la referencia se imprime como la escribió el documento', () => {
    const frame = composeFrame(context, template, prescription);

    expect(frame.title).toBe('RECETA MÉDICA');
    expect(frame.reference).toBe('Receta N.º 128');
    expect(frame.accentColour).toBe('#0f6b5c');
  });

  it('DOC-080 la cabecera lleva el nombre comercial, y la razón social sólo si no lo hay', () => {
    expect(headerOf(context).establishmentName).toBe('Clínica Andina');

    const withoutTradeName: DocumentContext = {
      ...context,
      establishment: { ...context.establishment, tradeName: null },
    };
    expect(headerOf(withoutTradeName).establishmentName).toBe(
      'CLÍNICA ANDINA CLIANDINA S.A.',
    );
  });

  it('DOC-024 el autor del PDF es la razón social, que es la persona jurídica', () => {
    expect(
      composeFrame(context, template, prescription).establishmentName,
    ).toBe('CLÍNICA ANDINA CLIANDINA S.A.');
  });

  it('DOC-034 DOC-080 imprime RUC, dirección y teléfono sólo con su interruptor, y correo y permiso cuando existen', () => {
    expect(headerOf(context)).toEqual({
      establishmentName: 'Clínica Andina',
      siteLine: null,
      establishmentRuc: '1791234567001',
      establishmentAddress: 'Av. Amazonas N34-120',
      establishmentPhone: null,
      establishmentEmail: 'contacto@example.com',
      operatingPermit: 'ACESS-2026-0456',
      hasLogo: false,
      fields: [{ label: 'Horario', value: '08:00 a 18:00' }],
    });
  });

  it('DOC-081 con una sola sede no lleva línea de sede, y con varias lleva la que emite', () => {
    expect(headerOf(context).siteLine).toBeNull();

    const twoSites: DocumentContext = {
      ...context,
      siteLine: 'Sede Norte · Unicódigo 012345',
    };
    expect(headerOf(twoSites).siteLine).toBe('Sede Norte · Unicódigo 012345');
  });

  it('DOC-082 rotula CONFIDENCIAL sólo el documento que imprime un diagnóstico', () => {
    expect(composeFrame(context, template, prescription).confidential).toBe(
      true,
    );
    expect(
      composeFrame(context, template, { ...prescription, confidential: false })
        .confidential,
    ).toBe(false);
  });

  it('DOC-083 el pie lleva el código, la dirección de verificación y el texto de la plantilla', () => {
    const { footer } = composeFrame(context, template, prescription);

    expect(footer.text).toBe('Atención de lunes a sábado');
    expect(footer.verification).toEqual({
      code: 'A1B2C3D4E5F60718',
      url: 'https://clinica.example/verificar/A1B2C3D4E5F60718',
    });
  });

  it('DOC-083 el código va escapado en la dirección: nunca rompe la URL', () => {
    const { footer } = composeFrame(context, template, {
      ...prescription,
      verificationCode: 'A B/C',
    });
    expect(footer.verification?.url).toBe(
      'https://clinica.example/verificar/A%20B%2FC',
    );
  });

  it('DOC-083 un documento sin código no lleva verificación: no hay QR que no lleve a ninguna parte', () => {
    const { footer } = composeFrame(context, template, {
      kind: 'SERVICE_ORDER',
      reference: 'N.º 342',
      confidential: true,
      verificationCode: null,
    });
    expect(footer.verification).toBeNull();
  });

  it('DOC-083 cada clase lleva su nota, y ni la receta ni la orden recitan la norma', () => {
    const notes = (kind: FrameRequest['kind']) =>
      composeFrame(context, template, { ...prescription, kind }).footer.notes;

    // Revisión de usabilidad del autor (04-10-2026): la conservación se cumple
    // (DOC-013), no se le imprime al paciente.
    expect(notes('PRESCRIPTION').join(' ')).not.toMatch(
      /conservad|ACESS|art\./i,
    );
    // D-121: la orden ya lleva su número; la línea sólo citaba el acuerdo.
    expect(notes('SERVICE_ORDER')).toEqual([]);
    expect(notes('INVOICE_RIDE').join(' ')).toContain('RIDE');
  });

  it('DOC-084 el RIDE no lleva la cabecera común ni verificación, aunque se la pidan', () => {
    const frame = composeFrame(context, template, {
      kind: 'INVOICE_RIDE',
      reference: 'N.º 001-002-000000013',
      confidential: false,
      verificationCode: 'NO-DEBE-SALIR',
    });

    expect(frame.header).toBeNull();
    expect(frame.footer.verification).toBeNull();
  });
});
