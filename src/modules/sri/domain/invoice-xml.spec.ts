import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import { composeAccessKey } from './access-key';
import {
  composeInvoiceXml,
  escapeXml,
  hasVoucherRootId,
  INVOICE_SCHEMA_VERSION,
  VoucherKeyMismatchError,
  VoucherLineCodeTooLongError,
  VoucherTotalsMismatchError,
  type InvoiceVoucherSource,
} from './invoice-xml';

const XSD_DIR = join(process.cwd(), 'src/modules/sri/infrastructure/xsd');

/**
 * Validates against the SRI's OFFICIAL XSD 1.1.0 (`XML y XSD Factura.zip`,
 * sri.gob.ec), versioned in the repository with the W3C xmldsig schema it
 * imports. A composer that only passed its own assertions could drift from
 * the schema without anybody noticing until the SRI answered 35.
 */
async function validateAgainstXsd(xml: string) {
  return validateXML({
    xml: [{ fileName: 'factura.xml', contents: xml }],
    schema: [
      {
        fileName: 'factura_V1.1.0.xsd',
        contents: readFileSync(join(XSD_DIR, 'factura_V1.1.0.xsd'), 'utf8'),
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

const ISSUED_ON = parseClinicalDate('2026-09-30'); // fecha-fija: dato de entrada de una función pura, sin reloj

function aSource(
  overrides: Partial<InvoiceVoucherSource> = {},
): InvoiceVoucherSource {
  const accessKey = composeAccessKey({
    issuedOn: ISSUED_ON,
    documentType: '01',
    ruc: '1790001563001',
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '002',
    sequential: '000000123',
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
    sequential: '000000123',
    issuedOn: ISSUED_ON,
    buyer: {
      identificationType: '05',
      identification: '1710034065',
      name: 'Guamán Andrade, María José',
      email: 'maria@example.com',
    },
    // A 0 % consultation and a 15 % supply with a discount.
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
    // gross 30.00 + 4.05; discount 0.05; tax round(4.00 × 15 %) = 0.60.
    totals: {
      subtotalTaxed: '4.05',
      subtotalUntaxed: '30.00',
      discountTotal: '0.05',
      taxTotal: '0.60',
      total: '34.60',
    },
    paymentMethod: '01',
    softwareProviderRuc: null,
    ...overrides,
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name) =>
    ['detalle', 'totalImpuesto', 'campoAdicional', 'pago'].includes(name),
});

interface ParsedTax {
  codigo: string;
  codigoPorcentaje: string;
  tarifa: string;
  baseImponible: string;
  valor: string;
}

/** The parts of the parsed voucher these tests read. */
interface ParsedFactura {
  infoTributaria: Record<string, unknown>;
  infoFactura: {
    [element: string]: unknown;
    totalConImpuestos: { totalImpuesto: ParsedTax[] };
    pagos: { pago: { formaPago: string; total: string }[] };
  };
  detalles: {
    detalle: (Record<string, unknown> & {
      impuestos: { impuesto: ParsedTax };
    })[];
  };
  infoAdicional: {
    campoAdicional: { '@_nombre': string; '#text': string }[];
  };
}

function parsed(xml: string): ParsedFactura {
  return (parser.parse(xml) as { factura: ParsedFactura }).factura;
}

describe('SRI-010 la factura 1.1.0 según el XSD oficial', () => {
  it('SRI-010 el XML compuesto valida contra el XSD oficial de la factura 1.1.0', async () => {
    const result = await validateAgainstXsd(composeInvoiceXml(aSource()));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('SRI-010 control: un XML al que le falta un elemento obligatorio NO valida', async () => {
    const broken = composeInvoiceXml(aSource()).replace(
      /<dirMatriz>.*?<\/dirMatriz>/,
      '',
    );
    const result = await validateAgainstXsd(broken);
    expect(result.valid).toBe(false);
  });

  it('SRI-010 SRI-015 la raíz lleva id="comprobante" y la versión, declarada en un solo sitio', () => {
    const xml = composeInvoiceXml(aSource());
    expect(xml).toContain(
      `<factura id="comprobante" version="${INVOICE_SCHEMA_VERSION}">`,
    );
    expect(INVOICE_SCHEMA_VERSION).toBe('1.1.0');
    expect(hasVoucherRootId(xml)).toBe(true);
  });

  it('SRI-010 escribe los bloques en el orden del XSD', () => {
    const xml = composeInvoiceXml(aSource());
    const order = [
      'infoTributaria',
      'infoFactura',
      'detalles',
      'infoAdicional',
    ];
    const positions = order.map((name) => xml.indexOf(`<${name}>`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('SRI-011, SRI-013 las líneas y los impuestos', () => {
  it('SRI-013 desglosa el IVA por línea y agrupa los totales por codigoPorcentaje', () => {
    const factura = parsed(composeInvoiceXml(aSource()));
    const [consultation, supply] = factura.detalles.detalle;
    if (!consultation || !supply) throw new Error('two lines expected');

    expect(consultation.impuestos.impuesto).toMatchObject({
      codigo: '2',
      codigoPorcentaje: '0',
      tarifa: '0.00',
      baseImponible: '30.00',
      valor: '0.00',
    });
    expect(supply.precioTotalSinImpuesto).toBe('4.00');
    expect(supply.impuestos.impuesto).toMatchObject({
      codigoPorcentaje: '4',
      tarifa: '15.00',
      baseImponible: '4.00',
      valor: '0.60',
    });

    const taxes = factura.infoFactura.totalConImpuestos.totalImpuesto;
    expect(taxes).toEqual([
      expect.objectContaining({
        codigoPorcentaje: '0',
        baseImponible: '30.00',
        valor: '0.00',
      }),
      expect.objectContaining({
        codigoPorcentaje: '4',
        baseImponible: '4.00',
        valor: '0.60',
      }),
    ]);
    expect(factura.infoFactura.totalSinImpuestos).toBe('34.00');
    expect(factura.infoFactura.totalDescuento).toBe('0.05');
    expect(factura.infoFactura.importeTotal).toBe('34.60');
  });

  it('SRI-011 SRI-013 rechaza componer si las líneas no suman lo que la factura guardó', () => {
    expect(() =>
      composeInvoiceXml(
        aSource({
          totals: { ...aSource().totals, taxTotal: '0.61', total: '34.61' },
        }),
      ),
    ).toThrow(VoucherTotalsMismatchError);
  });

  it('SRI-011 usa la descripción y el código congelados en la línea, tal cual', () => {
    const factura = parsed(composeInvoiceXml(aSource()));
    expect(factura.detalles.detalle[0]).toMatchObject({
      codigoPrincipal: 'CONS-MG-PV',
      descripcion: 'Consulta de medicina general',
    });
  });
});

describe('SRI-019 el contenido dice lo mismo que la clave', () => {
  it.each([
    ['ruc', { issuer: { ...aSource().issuer, ruc: '1790001564001' } }],
    ['establishmentCode', { establishmentCode: '002' }],
    ['emissionPointCode', { emissionPointCode: '001' }],
    ['sequential', { sequential: '000000124' }],
    ['issuedOn', { issuedOn: parseClinicalDate('2026-10-01') }], // fecha-fija: un día distinto del de la clave
    ['environment', { environment: '2' as const }],
  ] as const)(
    'SRI-019 rechaza componer un XML cuyo %s no es el de su clave',
    (part, override) => {
      expect(() => composeInvoiceXml({ ...aSource(), ...override })).toThrow(
        new VoucherKeyMismatchError(part),
      );
    },
  );
});

describe('SRI-014 la cantidad fraccionaria de un insumo', () => {
  it('SRI-013 SRI-014 media unidad a 10.00 suma 5.00 y se declara con seis decimales', async () => {
    const half = aSource({
      lines: [
        {
          code: 'INS-VIAL',
          description: 'Vial',
          quantity: '0.500',
          unitPrice: '10.00',
          discount: '0.00',
          taxSriCode: '0',
          taxPercentage: '0.00',
        },
      ],
      totals: {
        subtotalTaxed: '0.00',
        subtotalUntaxed: '5.00',
        discountTotal: '0.00',
        taxTotal: '0.00',
        total: '5.00',
      },
    });
    const factura = parsed(composeInvoiceXml(half));
    expect(factura.detalles.detalle[0]).toMatchObject({
      cantidad: '0.500000',
      precioUnitario: '10.000000',
      precioTotalSinImpuesto: '5.00',
    });
    expect((await validateAgainstXsd(composeInvoiceXml(half))).valid).toBe(
      true,
    );
  });

  it('SRI-013 redondea la línea como billing: 0.333 × 1.00 es 0.33', () => {
    const third = aSource({
      lines: [
        {
          code: 'INS-X',
          description: 'Insumo',
          quantity: '0.333',
          unitPrice: '1.00',
          discount: '0.00',
          taxSriCode: '0',
          taxPercentage: '0.00',
        },
      ],
      totals: {
        subtotalTaxed: '0.00',
        subtotalUntaxed: '0.33',
        discountTotal: '0.00',
        taxTotal: '0.00',
        total: '0.33',
      },
    });
    expect(() => composeInvoiceXml(third)).not.toThrow();
  });
});

describe('SRI-011 el código de la prestación en el comprobante', () => {
  it('SRI-011 el código es obligatorio (Ficha, pág. 50): uno de más de 25 se rechaza, ni se recorta ni se omite', () => {
    const long = aSource({
      lines: [
        { ...aSource().lines[0]!, code: 'C'.repeat(26) },
        aSource().lines[1]!,
      ],
    });
    expect(() => composeInvoiceXml(long)).toThrow(VoucherLineCodeTooLongError);
    // Control: 25 is admitted and travels whole.
    const xml = composeInvoiceXml(
      aSource({
        lines: [
          { ...aSource().lines[0]!, code: 'C'.repeat(25) },
          aSource().lines[1]!,
        ],
      }),
    );
    expect(xml).toContain(
      `<codigoPrincipal>${'C'.repeat(25)}</codigoPrincipal>`,
    );
  });
});

describe('SRI-014 formatos y escape', () => {
  it('SRI-014 fecha dd/mm/aaaa, seis decimales en cantidad y precio, dos en lo demás', () => {
    const factura = parsed(composeInvoiceXml(aSource()));
    expect(factura.infoFactura.fechaEmision).toBe('30/09/2026');
    expect(factura.detalles.detalle[1]).toMatchObject({
      cantidad: '3.000000',
      precioUnitario: '1.350000',
      descuento: '0.05',
    });
  });

  it('SRI-014 escapa el ampersand y los demás reservados de lo que escribe una persona', async () => {
    const xml = composeInvoiceXml(
      aSource({
        issuer: { ...aSource().issuer, legalName: 'Pérez & Hijos <Clínica>' },
        buyer: { ...aSource().buyer, name: 'O\'Brien "Tom"' },
      }),
    );
    expect(xml).toContain(
      '<razonSocial>Pérez &amp; Hijos &lt;Clínica&gt;</razonSocial>',
    );
    expect(xml).toContain('O&apos;Brien &quot;Tom&quot;');
    expect((await validateAgainstXsd(xml)).valid).toBe(true);
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });

  it('SRI-014 quita los caracteres que XML 1.0 no admite, y el XML sigue validando', async () => {
    expect(escapeXml('Ana\u0007 Pérez\uD800')).toBe('Ana Pérez');
    expect(escapeXml('emoji 🩺 entero')).toBe('emoji 🩺 entero');
    const xml = composeInvoiceXml(
      aSource({
        buyer: { ...aSource().buyer, name: 'Guamán\u0001 Andrade' },
      }),
    );
    expect(xml).toContain(
      '<razonSocialComprador>Guamán Andrade</razonSocialComprador>',
    );
    expect((await validateAgainstXsd(xml)).valid).toBe(true);
  });
});

describe('SRI-016, SRI-017, SRI-018 los datos del emisor, el pago y la información adicional', () => {
  it('SRI-017 incluye propina en cero y pagos con la forma declarada por el total', () => {
    const factura = parsed(composeInvoiceXml(aSource({ paymentMethod: '19' })));
    expect(factura.infoFactura.propina).toBe('0.00');
    expect(factura.infoFactura.pagos.pago).toEqual([
      { formaPago: '19', total: '34.60' },
    ]);
  });

  it('SRI-017 sin forma de pago declarada omite pagos y sigue siendo XML válido, para que la preparación lo bloquee', async () => {
    const xml = composeInvoiceXml(aSource({ paymentMethod: null }));
    expect(xml).not.toContain('<pagos>');
    expect((await validateAgainstXsd(xml)).valid).toBe(true);
  });

  it('SRI-016 lleva el correo del receptor y, solo si está declarado, el «RUC Proveedor» literal del Anexo 26', () => {
    const without = parsed(composeInvoiceXml(aSource()));
    expect(without.infoAdicional.campoAdicional).toEqual([
      { '@_nombre': 'Email', '#text': 'maria@example.com' },
    ]);

    const withProvider = parsed(
      composeInvoiceXml(aSource({ softwareProviderRuc: '1790001563001' })),
    );
    expect(withProvider.infoAdicional.campoAdicional).toContainEqual({
      '@_nombre': 'RUC Proveedor',
      '#text': '1790001563001',
    });
  });

  it('SRI-016 sin correo ni proveedor no hay infoAdicional, y sigue validando', async () => {
    const xml = composeInvoiceXml(
      aSource({ buyer: { ...aSource().buyer, email: null } }),
    );
    expect(xml).not.toContain('infoAdicional');
    expect((await validateAgainstXsd(xml)).valid).toBe(true);
  });

  it('SRI-018 infoTributaria con dirMatriz, y las banderas fiscales solo cuando están puestas', async () => {
    const plain = parsed(composeInvoiceXml(aSource()));
    expect(plain.infoTributaria.dirMatriz).toBe(
      'Av. Amazonas y Naciones Unidas, Quito',
    );
    expect(plain.infoTributaria.agenteRetencion).toBeUndefined();
    expect(plain.infoTributaria.contribuyenteRimpe).toBeUndefined();
    expect(plain.infoFactura.obligadoContabilidad).toBe('SI');
    expect(plain.infoFactura.contribuyenteEspecial).toBeUndefined();

    const flagged = composeInvoiceXml(
      aSource({
        issuer: {
          ...aSource().issuer,
          keepsAccounting: false,
          specialTaxpayerResolution: '5368',
          withholdingAgentResolution: '00000001',
          rimpeRegime: 'ENTREPRENEUR',
        },
      }),
    );
    const factura = parsed(flagged);
    expect(factura.infoTributaria.agenteRetencion).toBe('1');
    expect(factura.infoTributaria.contribuyenteRimpe).toBe(
      'CONTRIBUYENTE RÉGIMEN RIMPE',
    );
    expect(factura.infoFactura.contribuyenteEspecial).toBe('5368');
    expect(factura.infoFactura.obligadoContabilidad).toBe('NO');
    expect((await validateAgainstXsd(flagged)).valid).toBe(true);
  });

  it('SRI-018 el negocio popular lleva la leyenda de la Ficha v2.34, que el XSD de 2022 aún no conoce', () => {
    const factura = parsed(
      composeInvoiceXml(
        aSource({
          issuer: { ...aSource().issuer, rimpeRegime: 'POPULAR_BUSINESS' },
        }),
      ),
    );
    expect(factura.infoTributaria.contribuyenteRimpe).toBe(
      'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
    );
  });
});

describe('SRI-015 la raíz se comprueba antes de firmar', () => {
  it('SRI-015 reconoce una raíz sin id="comprobante", o con Id en mayúscula', () => {
    expect(hasVoucherRootId('<factura version="1.1.0"></factura>')).toBe(false);
    expect(
      hasVoucherRootId('<factura Id="comprobante" version="1.1.0"></factura>'),
    ).toBe(false);
    expect(
      hasVoucherRootId('<factura id="comprobante" version="1.1.0"></factura>'),
    ).toBe(true);
  });
});
