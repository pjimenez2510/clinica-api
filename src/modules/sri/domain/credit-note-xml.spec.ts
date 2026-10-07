import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import { composeAccessKey } from './access-key';
import {
  composeCreditNoteXml,
  CREDIT_NOTE_SCHEMA_VERSION,
  documentNumber,
  type CreditNoteVoucherSource,
} from './credit-note-xml';
import { hasVoucherRootId } from './invoice-xml';
import {
  VoucherKeyMismatchError,
  VoucherLineCodeTooLongError,
  VoucherTotalsMismatchError,
} from './voucher-xml';

const XSD_DIR = join(process.cwd(), 'src/modules/sri/infrastructure/xsd');

/**
 * Validates against the SRI's OFFICIAL XSD of the credit note, 1.1.0
 * (`XML y XSD Nota de Crédito.zip`, sri.gob.ec, February 2022), versioned in
 * the repository as published, with the W3C xmldsig schema it imports.
 */
async function validateAgainstXsd(xml: string) {
  return validateXML({
    xml: [{ fileName: 'notaCredito.xml', contents: xml }],
    schema: [
      {
        fileName: 'NotaCredito_V1.1.0.xsd',
        contents: readFileSync(join(XSD_DIR, 'NotaCredito_V1.1.0.xsd'), 'utf8'),
      },
    ],
    preload: [
      {
        fileName: 'xmldsig-core-schema.xsd',
        contents: readFileSync(
          join(XSD_DIR, 'xmldsig-core-schema.xsd'),
          'utf8',
        ),
      },
    ],
  });
}

const ISSUED_ON = parseClinicalDate('2026-10-06'); // fecha-fija: dato de entrada de una función pura, sin reloj
const INVOICE_ISSUED_ON = parseClinicalDate('2026-09-30'); // fecha-fija: dato de entrada de una función pura, sin reloj

function aSource(
  overrides: Partial<CreditNoteVoucherSource> = {},
): CreditNoteVoucherSource {
  const accessKey = composeAccessKey({
    issuedOn: ISSUED_ON,
    documentType: '04',
    ruc: '1790001563001',
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '002',
    sequential: '000000007',
    numericCode: '00456789',
  });
  return {
    environment: '1',
    accessKey,
    issuer: {
      ruc: '1790001563001',
      legalName: 'Clínica de Desarrollo S.A.',
      headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
      establishmentAddress: 'Av. de los Granados y 6 de Diciembre, Quito',
      keepsAccounting: true,
      specialTaxpayerResolution: null,
      withholdingAgentResolution: null,
      rimpeRegime: 'NONE',
    },
    establishmentCode: '001',
    emissionPointCode: '002',
    sequential: '000000007',
    issuedOn: ISSUED_ON,
    buyer: {
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
      email: 'maria@example.com',
    },
    modifiedDocument: {
      number: documentNumber({
        establishmentCode: '001',
        emissionPointCode: '002',
        sequential: '000000123',
      }),
      issuedOn: INVOICE_ISSUED_ON,
    },
    reason: 'Error en los datos del receptor',
    lines: [
      {
        code: 'CONS-MG-PV',
        description: 'Consulta de medicina general',
        quantity: '1',
        unitPrice: '30.00',
        discount: '0.00',
        taxSriCode: '0',
        taxPercentage: '0.00',
      },
      {
        code: 'INS-GUANTES',
        description: 'Guantes de examen',
        quantity: '3',
        unitPrice: '1.35',
        discount: '0.05',
        taxSriCode: '4',
        taxPercentage: '15.00',
      },
    ],
    totals: {
      subtotalTaxed: '4.05',
      subtotalUntaxed: '30.00',
      discountTotal: '0.05',
      taxTotal: '0.60',
      total: '34.60',
    },
    softwareProviderRuc: null,
    ...overrides,
  };
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

/** The parsed credit note, typed only as far as these assertions read it. */
interface ParsedNote {
  notaCredito: {
    '@_version': string;
    infoTributaria: { codDoc: string };
    infoNotaCredito: Record<string, unknown> & {
      totalConImpuestos: { totalImpuesto: unknown };
    };
    detalles: { detalle: unknown };
  };
}

describe('SRI-085 el XML de la nota de crédito', () => {
  it('SRI-085 una nota de crédito de una sola línea al 0 % es válida contra el XSD', async () => {
    const result = await validateAgainstXsd(
      composeCreditNoteXml(aSource({ lines: aSource().lines.slice(0, 1), totals: { subtotalTaxed: '0.00', subtotalUntaxed: '30.00', discountTotal: '0.00', taxTotal: '0.00', total: '30.00' } })), // prettier-ignore
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('SRI-085 compone una nota de crédito válida contra el XSD oficial 1.1.0', async () => {
    const xml = composeCreditNoteXml(aSource());
    const result = await validateAgainstXsd(xml);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(hasVoucherRootId(xml)).toBe(true);
  });

  it('SRI-085 nombra la factura que modifica, su fecha, el valor y el motivo', () => {
    const doc = parser.parse(composeCreditNoteXml(aSource())) as ParsedNote;
    const note = doc.notaCredito;

    expect(note['@_version']).toBe(CREDIT_NOTE_SCHEMA_VERSION);
    expect(note.infoTributaria.codDoc).toBe('04');
    expect(note.infoNotaCredito).toMatchObject({
      fechaEmision: '06/10/2026',
      codDocModificado: '01',
      numDocModificado: '001-002-000000123',
      fechaEmisionDocSustento: '30/09/2026',
      totalSinImpuestos: '34.00',
      valorModificacion: '34.60',
      moneda: 'DOLAR',
      motivo: 'Error en los datos del receptor',
      identificacionComprador: '1710034065',
    });
    // The credit note's `totalImpuesto` has no `tarifa` in its XSD.
    const totals = [
      note.infoNotaCredito.totalConImpuestos.totalImpuesto,
    ].flat();
    expect(totals).toEqual([
      {
        codigo: '2',
        codigoPorcentaje: '0',
        baseImponible: '30.00',
        valor: '0.00',
      },
      {
        codigo: '2',
        codigoPorcentaje: '4',
        baseImponible: '4.00',
        valor: '0.60',
      },
    ]);
    const details = [note.detalles.detalle].flat();
    expect(details[0]).toMatchObject({
      codigoInterno: 'CONS-MG-PV',
      cantidad: '1.000000',
      precioUnitario: '30.000000',
      precioTotalSinImpuesto: '30.00',
    });
  });

  it('SRI-085 escapa el motivo escrito con «Otro» y sigue siendo válida', async () => {
    const xml = composeCreditNoteXml(
      aSource({ reason: 'Cobro duplicado <consulta> & examen' }),
    );
    expect(xml).toContain(
      '<motivo>Cobro duplicado &lt;consulta&gt; &amp; examen</motivo>',
    );
    expect((await validateAgainstXsd(xml)).valid).toBe(true);
  });

  it('SRI-085 rechaza componer con totales que no cuadran con las líneas', () => {
    expect(() =>
      composeCreditNoteXml(
        aSource({ totals: { ...aSource().totals, total: '34.61' } }),
      ),
    ).toThrow(VoucherTotalsMismatchError);
  });

  it('SRI-085 rechaza componer con una clave que no es la de la nota de crédito', () => {
    expect(() =>
      composeCreditNoteXml(aSource({ sequential: '000000008' })),
    ).toThrow(VoucherKeyMismatchError);
  });

  it('SRI-085 rechaza una línea cuyo código no cabe en codigoInterno', () => {
    const [first] = aSource().lines;
    expect(() =>
      composeCreditNoteXml(
        aSource({
          lines: [{ ...first!, code: 'X'.repeat(26) }],
          totals: { subtotalTaxed: '0.00', subtotalUntaxed: '30.00', discountTotal: '0.00', taxTotal: '0.00', total: '30.00' }, // prettier-ignore
        }),
      ),
    ).toThrow(VoucherLineCodeTooLongError);
  });
});
