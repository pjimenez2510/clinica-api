import { describe, expect, it } from 'vitest';

import { composeLayout } from './document-layout';
import { TEAR_OFF_HEIGHT_MM, millimetresToPoints } from './page-layout';
import type { DocumentTemplate } from './document-template';
import type {
  DocumentContext,
  DocumentSubject,
  PatientIdentity,
  PractitionerIdentity,
} from './document-source';
import type { Block, DocumentHeader, DocumentLayout } from './page-layout';

/**
 * DOC-070 to DOC-078. The four documents, composed with plain objects.
 *
 * PURE IN, PURE OUT: no PDF engine, no database, no clock. That is what lets
 * «¿lleva el documento el registro ACESS del prescriptor?» be asserted in a
 * millisecond, which is the whole reason the layout is a data structure.
 */

const template: DocumentTemplate = {
  id: 'template-1',
  kind: 'PRESCRIPTION',
  version: 3,
  accentColour: '#1f6f8b',
  footerText: 'Clínica de especialidades · Guayaquil',
  headerFields: [{ label: 'Permiso ACESS', value: '0000-0000' }],
  showEstablishmentRuc: false,
  showEstablishmentAddress: false,
  showEstablishmentPhone: false,
  publishedAt: new Date('2026-08-01T12:00:00Z'),
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
    specialTaxpayerResolution: '1234',
    withholdingAgentResolution: '5678',
    rimpeRegime: 'ENTREPRENEUR',
    tradeName: null,
    email: null,
    operatingPermit: null,
  },
};

const patient: PatientIdentity = {
  fullName: 'Guamán Andrade María José',
  identifier: '1710034065',
  ageYears: 1,
  ageMonths: 2,
};

const prescriber: PractitionerIdentity = {
  fullName: 'Cedeño Rosa',
  acessRegistration: 'ACESS-99887',
  mspCode: 'MSP-1',
  seal: null,
  signature: null,
};

/** Every string the layout carries, flattened, so a field can be looked for. */
function textOf(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return block.text;
        case 'paragraph':
          return block.text;
        case 'fields':
          return block.entries
            .map((entry) => `${entry.label}=${entry.value}`)
            .join('\n');
        case 'table':
          return [
            block.columns.map((column) => column.header).join('|'),
            ...block.rows.map((row) => row.join('|')),
          ].join('\n');
        case 'signature':
          return block.caption;
        case 'boxes':
          return `${textOf(block.left)}\n${textOf(block.right)}`;
        default:
          return '';
      }
    })
    .join('\n');
}

function wholeText(layout: DocumentLayout): string {
  const tearOff =
    layout.tearOff === null
      ? ''
      : [
          layout.tearOff.caption,
          layout.tearOff.identification
            .map((entry) => `${entry.label}=${entry.value}`)
            .join('\n'),
          textOf(layout.tearOff.blocks),
        ].join('\n');

  const header = layout.frame.header;
  return [
    layout.frame.title,
    layout.frame.reference ?? '',
    header?.establishmentName ?? '',
    header?.establishmentRuc ?? '',
    header?.establishmentAddress ?? '',
    header?.establishmentPhone ?? '',
    ...(header?.fields ?? []).map((field) => `${field.label}=${field.value}`),
    textOf(layout.blocks),
    tearOff,
    layout.frame.footer.text ?? '',
  ].join('\n');
}

/** The establishment's header; the three clinical documents always have one. */
function headerOf(layout: DocumentLayout): DocumentHeader {
  if (layout.frame.header === null) throw new Error('expected a header');
  return layout.frame.header;
}

const prescription = (
  overrides: Partial<
    Extract<DocumentSubject, { kind: 'PRESCRIPTION' }>['data']
  > = {},
): DocumentSubject => ({
  kind: 'PRESCRIPTION',
  data: {
    subjectId: 'prescription-1',
    siteId: 'site-1',
    status: 'ACTIVE',
    // 20:00 in Ecuador on the 20th. A `::date` in the session's zone would
    // already be the 21st in UTC, which is the defect this fixture exists for.
    issuedAt: new Date('2026-08-21T01:00:00Z'),
    city: 'Guayaquil',
    verificationCode: 'RX-7Q2K',
    patient,
    diagnoses: [{ code: 'J00', display: 'Rinofaringitis aguda' }],
    allergies: [],
    prescriber,
    lines: [
      {
        genericName: 'Amoxicilina',
        presentation: 'Tableta',
        concentration: '500 mg',
        routeCode: 'ORAL',
        quantity: 20,
        doseText: '1 tableta',
        frequencyText: 'cada 8 horas',
        durationDays: 7,
        instructions: 'Tomar con alimentos',
        offFormularyJustification: null,
      },
    ],
    ...overrides,
  },
});

describe('DOC-072 la receta lleva los cinco bloques del art. 5', () => {
  it('DOC-072 imprime ciudad, fecha, establecimiento, paciente, diagnóstico, alergias, medicamento y prescriptor', () => {
    const layout = composeLayout(prescription(), context, template);
    const text = wholeText(layout);

    // 5.a — datos generales.
    expect(text).toContain('Guayaquil');
    expect(text).toContain('Centro de Especialidades Bahía');
    // 5.a.ii — the date, RESOLVED IN ECUADOR. 01:00 UTC on the 21st is 20:00 on
    // the 20th in Guayaquil; a naive conversion prints tomorrow.
    expect(text).toContain('20/08/2026');
    // 5.b — datos del paciente, apellidos primero, edad en años y meses.
    expect(text).toContain('Guamán Andrade María José');
    expect(text).toContain('1 año 2 meses');
    expect(text).toContain('J00');
    // 5.c — datos del medicamento, con la cantidad en números y letras.
    expect(text).toContain('Amoxicilina');
    expect(text).toContain('20 (veinte)');
    expect(text).toContain('Vía oral');
    // 5.d — datos del prescriptor, con su registro ACESS.
    expect(text).toContain('Cedeño Rosa');
    expect(text).toContain('ACESS-99887');
    // 5.e — indicaciones.
    expect(text).toContain('Tomar con alimentos');
  });

  it('DOC-072 dice «Ninguna conocida» y no deja la casilla de alergias en blanco', () => {
    // A blank says nobody asked, and this field exists precisely to record that
    // somebody did (art. 5.b.iv).
    const layout = composeLayout(prescription(), context, template);
    expect(wholeText(layout)).toContain('Ninguna conocida');
  });

  it('DOC-072 enumera las alergias registradas cuando las hay', () => {
    const layout = composeLayout(
      prescription({ allergies: ['Penicilina', 'Látex'] }),
      context,
      template,
    );
    expect(wholeText(layout)).toContain('Penicilina, Látex');
  });

  it('DOC-072 deriva la vigencia y no la teclea', () => {
    // Arts. 17–19. A validity somebody keys in is a validity somebody can
    // extend; three days from the 20th ends on the 22nd, inclusive.
    const layout = composeLayout(prescription(), context, template);
    expect(wholeText(layout)).toContain('3 días — hasta el 22/08/2026');
  });

  it('DOC-072 imprime la justificación de una línea fuera del CNMB', () => {
    const layout = composeLayout(
      prescription({
        lines: [
          {
            genericName: 'Medicamento no incluido',
            presentation: null,
            concentration: null,
            routeCode: null,
            quantity: 1,
            doseText: '1 unidad',
            frequencyText: 'cada día',
            durationDays: null,
            instructions: null,
            offFormularyJustification: 'No hay alternativa en el cuadro',
          },
        ],
      }),
      context,
      template,
    );
    expect(wholeText(layout)).toContain('No hay alternativa en el cuadro');
  });

  it('DOC-074 deja la vía en blanco antes que imprimir un código que no sabe nombrar', () => {
    const layout = composeLayout(
      prescription({
        lines: [
          {
            genericName: 'Amoxicilina',
            presentation: null,
            concentration: null,
            routeCode: 'SOMETHING_NEW',
            quantity: 1,
            doseText: '1',
            frequencyText: 'cada día',
            durationDays: null,
            instructions: null,
            offFormularyJustification: null,
          },
        ],
      }),
      context,
      template,
    );
    expect(wholeText(layout)).not.toContain('SOMETHING_NEW');
  });
});

describe('DOC-073 la banda desprendible del art. 5.e', () => {
  it('DOC-073 existe, se llama por su nombre y repite paciente y fecha', () => {
    // A detached strip with no name on it is a loose piece of paper that does
    // not say whose it is.
    const layout = composeLayout(prescription(), context, template);

    expect(layout.tearOff).not.toBeNull();
    expect(layout.tearOff?.caption).toMatch(/recorte/i);
    const identification = layout.tearOff?.identification ?? [];
    expect(identification.map((entry) => entry.value)).toContain(
      'Guamán Andrade María José',
    );
    expect(identification.map((entry) => entry.value)).toContain('20/08/2026');
  });

  it('DOC-073 lleva el sello del prescriptor, que el art. 5 exige por segunda vez', () => {
    // Art. 5 demands the seal TWICE: `d.iii` on the prescriber block and
    // `e.iv` on the tear-off indications.
    const layout = composeLayout(prescription(), context, template);
    const seals = [...layout.blocks, ...(layout.tearOff?.blocks ?? [])].filter(
      (block) => block.kind === 'signature',
    );
    expect(seals).toHaveLength(2);
  });

  it('DOC-060 deja el sello como recuadro vacío cuando el profesional no tiene uno', () => {
    // The system cannot manufacture a seal, and art. 5.d.iii is textual: «no se
    // aceptarán rúbricas o trazos por firma».
    const layout = composeLayout(prescription(), context, template);
    const signatures = layout.blocks.filter(
      (block) => block.kind === 'signature',
    );
    expect(signatures.every((block) => block.image === null)).toBe(true);
  });

  it('DOC-060 usa el sello guardado cuando existe', () => {
    const sealed = prescription({
      prescriber: {
        ...prescriber,
        seal: {
          id: 'image-1',
          mimeType: 'image/png',
          bytes: Buffer.alloc(4),
          byteSize: 4,
          sha256: 'a'.repeat(64),
          width: 10,
          height: 10,
        },
      },
    });
    const layout = composeLayout(sealed, context, template);
    const signatures = layout.blocks.filter(
      (block) => block.kind === 'signature',
    );
    expect(signatures.every((block) => block.image === 'seal')).toBe(true);
  });

  it('DOC-073 la banda tiene altura fija, que es lo que la hace recortable', () => {
    // If the cut line landed where the text happened to end, it would not be
    // detachable: the pharmacist cuts through the posology on one receta and
    // through nothing on the next.
    expect(TEAR_OFF_HEIGHT_MM).toBeGreaterThan(0);
    expect(millimetresToPoints(TEAR_OFF_HEIGHT_MM)).toBeCloseTo(198.42, 1);
  });

  it('DOC-073 la banda dice que no hay indicaciones antes que quedarse vacía', () => {
    const layout = composeLayout(
      prescription({
        lines: [
          {
            genericName: 'Amoxicilina',
            presentation: null,
            concentration: null,
            routeCode: 'ORAL',
            quantity: 1,
            doseText: '1',
            frequencyText: 'cada día',
            durationDays: null,
            instructions: null,
            offFormularyJustification: null,
          },
        ],
      }),
      context,
      template,
    );
    expect(textOf(layout.tearOff?.blocks ?? [])).toContain(
      'Sin indicaciones adicionales',
    );
  });
});

describe('DOC-034 las ranuras de la plantilla', () => {
  it('DOC-034 no imprime RUC, dirección ni teléfono si la clínica no lo pidió', () => {
    // Art. 5 requires NONE of these three: the only establishment datum the
    // receta must carry is the NAME. Printing them is a decision.
    const layout = composeLayout(prescription(), context, template);
    expect(headerOf(layout).establishmentRuc).toBeNull();
    expect(headerOf(layout).establishmentAddress).toBeNull();
    expect(headerOf(layout).establishmentPhone).toBeNull();
  });

  it('DOC-034 los imprime cuando el interruptor está puesto', () => {
    const layout = composeLayout(prescription(), context, {
      ...template,
      showEstablishmentRuc: true,
      showEstablishmentAddress: true,
      showEstablishmentPhone: true,
    });
    expect(headerOf(layout).establishmentRuc).toBe('0993123456001');
    expect(headerOf(layout).establishmentAddress).toBe('Av. 9 de Octubre 123');
    expect(headerOf(layout).establishmentPhone).toBe('04-2345678');
  });

  it('DOC-034 lleva los campos clave-valor y el pie de la plantilla', () => {
    const layout = composeLayout(prescription(), context, template);
    expect(headerOf(layout).fields).toEqual([
      { label: 'Permiso ACESS', value: '0000-0000' },
    ]);
    expect(layout.frame.footer.text).toBe(
      'Clínica de especialidades · Guayaquil',
    );
    expect(layout.frame.accentColour).toBe('#1f6f8b');
  });
});

describe('DOC-072 la orden de examen', () => {
  it('DOC-072 lleva paciente, exámenes y profesional solicitante', () => {
    const layout = composeLayout(
      {
        kind: 'SERVICE_ORDER',
        data: {
          subjectId: 'order-1',
          siteId: 'site-1',
          requestedAt: new Date('2026-08-21T01:00:00Z'),
          category: 'LABORATORY',
          priority: 'ROUTINE',
          clinicalNoteText: 'Paciente en ayunas',
          patient,
          diagnoses: [{ code: 'E11', display: 'Diabetes mellitus tipo 2' }],
          orderedBy: prescriber,
          items: [{ display: 'Hemoglobina glicosilada', status: 'REQUESTED' }],
        },
      },
      context,
      template,
    );
    const text = wholeText(layout);

    expect(layout.frame.title).toBe('ORDEN DE EXÁMENES');
    expect(layout.tearOff).toBeNull();
    expect(text).toContain('Hemoglobina glicosilada');
    expect(text).toContain('Paciente en ayunas');
    expect(text).toContain('ACESS-99887');
    expect(text).toContain('20/08/2026');
  });
});

describe('DOC-075 el certificado sobre el formulario 117', () => {
  const certificate = (
    overrides: Partial<
      Extract<DocumentSubject, { kind: 'MEDICAL_CERTIFICATE' }>['data']
    > = {},
  ): DocumentSubject => ({
    kind: 'MEDICAL_CERTIFICATE',
    data: {
      subjectId: 'certificate-1',
      siteId: 'site-1',
      type: 'MEDICAL_REST',
      issuedAt: new Date('2026-08-21T01:00:00Z'),
      restFrom: new Date('2026-08-21T00:00:00Z'),
      restTo: new Date('2026-08-23T00:00:00Z'),
      includeDiagnosis: false,
      diagnoses: [{ code: 'J00', display: 'Rinofaringitis aguda' }],
      body: 'Se certifica que requiere reposo médico',
      verificationCode: 'CM-4T7',
      revokedAt: null,
      patient,
      issuedBy: prescriber,
      ...overrides,
    },
  });

  it('DOC-075 nombra el formulario y lleva el reposo y el código de verificación', () => {
    const text = wholeText(composeLayout(certificate(), context, template));
    expect(text).toContain('117');
    expect(text).toContain('21/08/2026');
    expect(text).toContain('23/08/2026');
    expect(text).toContain('CM-4T7');
  });

  it('DOC-075 NO imprime el diagnóstico si el paciente no lo autorizó', () => {
    // This is the document their EMPLOYER reads. Privacy by default is an LOPDP
    // requirement, not a preference, and the schema defaults the flag to false.
    const text = wholeText(composeLayout(certificate(), context, template));
    expect(text).not.toContain('Rinofaringitis');
  });

  it('DOC-075 lo imprime cuando el paciente lo autorizó', () => {
    const text = wholeText(
      composeLayout(certificate({ includeDiagnosis: true }), context, template),
    );
    expect(text).toContain('Rinofaringitis aguda');
  });

  it('DOC-075 dice en la cara del documento que está anulado', () => {
    // Somebody is holding the paper. A revoked certificate that printed like a
    // valid one is the failure this line exists for.
    const text = wholeText(
      composeLayout(
        certificate({ revokedAt: new Date('2026-08-25T15:00:00Z') }),
        context,
        template,
      ),
    );
    expect(text).toMatch(/ANULADO/);
  });
});

describe('DOC-076 a DOC-078 el RIDE de la factura', () => {
  const ride: DocumentSubject = {
    kind: 'INVOICE_RIDE',
    data: {
      subjectId: 'invoice-1',
      siteId: 'site-1',
      documentNumber: '001-001-000000001',
      accessKey: '4'.repeat(49),
      status: 'AUTHORISED',
      issuedAt: new Date('2026-08-21T01:00:00Z'),
      authorisedAt: new Date('2026-08-21T01:05:00Z'),
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade María José',
      buyerEmail: 'maria@example.com',
      buyerAddress: 'Calle Ulloa N25-10, Quito',
      paymentMethod: '19',
      patient: {
        fullName: 'GUAMÁN ANDRADE María José',
        mrn: 'HC0000000801',
        phone: '099 876 5432',
      },
      attendedOn: new Date('2026-08-20T00:00:00Z'), // fecha-fija: fecha de servicio, columna date
      lines: [
        {
          code: 'CONS-MG-PV',
          auxiliaryCode: '99203',
          description: 'Consulta de medicina general',
          quantity: '1.00',
          unitPrice: '30.00',
          discount: '0.00',
          total: '30.00',
          taxSriCode: '0',
          taxPercentage: '0.00',
        },
        {
          code: 'INS-GUANTES',
          auxiliaryCode: null,
          description: 'Guantes de examen',
          quantity: '2.00',
          unitPrice: '2.00',
          discount: '0.00',
          total: '4.00',
          taxSriCode: '4',
          taxPercentage: '15.00',
        },
      ],
      subtotalTaxed: '4.00',
      subtotalUntaxed: '30.00',
      discountTotal: '0.00',
      taxTotal: '0.60',
      total: '34.60',
    },
  };

  it('DOC-076 lleva las dos cajas del Anexo 2, con RUC, número y clave de acceso', () => {
    const layout = composeLayout(ride, context, template);
    // The issuer and the voucher head the page, side by side.
    expect(layout.blocks[0]?.kind).toBe('boxes');

    const text = wholeText(layout);
    expect(text).toContain('0993123456001');
    expect(text).toContain('001-001-000000001');
    expect(text).toContain('CLAVE DE ACCESO');
    expect(text).toContain('4'.repeat(49));
  });

  it('DOC-076 sigue la página «Factura» aprobada (D-095): emisor, comprador, detalle, información adicional, forma de pago y subtotales', () => {
    const layout = composeLayout(
      ride,
      {
        ...context,
        establishment: { ...context.establishment, tradeName: 'Bahía Salud' },
      },
      template,
    );
    const text = wholeText(layout);
    // Emisor: razón social, nombre comercial, matriz y establecimiento.
    expect(text).toContain('Centro de Especialidades Bahía');
    expect(text).toContain('Bahía Salud');
    expect(text).toContain('DIRECCIÓN MATRIZ=Av. Malecón 100, Guayaquil');
    expect(text).toContain('DIRECCIÓN ESTABLECIMIENTO=Av. 9 de Octubre 123');
    // Comprador, con su dirección.
    expect(text).toContain('Dirección=Calle Ulloa N25-10, Quito');
    // Detalle: código principal y auxiliar.
    expect(text).toContain(
      'Cód. principal|Cód. auxiliar|Cant.|Descripción|Precio unitario|Descuento|Precio total',
    );
    expect(text).toContain(
      'CONS-MG-PV|99203|1.00|Consulta de medicina general',
    );
    expect(text).toContain('INS-GUANTES|—|2.00|Guantes de examen');
    // Información adicional.
    expect(text).toContain('Información adicional');
    expect(text).toContain('Correo=maria@example.com');
    expect(text).toContain('Teléfono=099 876 5432');
    expect(text).toContain('Paciente=GUAMÁN ANDRADE María José · HC0000000801');
    expect(text).toContain('Atención=20/08/2026 · Sede Centro');
    // Forma de pago con su código de la tabla 24.
    expect(text).toContain('19 · Tarjeta de crédito|34.60');
    // Subtotales, todos, en el orden del Anexo 2.
    const subtotals = [
      'SUBTOTAL 15%|4.00',
      'SUBTOTAL 0%|30.00',
      'SUBTOTAL NO OBJETO DE IVA|0.00',
      'SUBTOTAL EXENTO DE IVA|0.00',
      'SUBTOTAL SIN IMPUESTOS|34.00',
      'TOTAL DESCUENTO|0.00',
      'ICE|0.00',
      'IVA 15%|0.60',
      'PROPINA|0.00',
      'VALOR TOTAL|34.60',
    ];
    expect(text).toContain(subtotals.join('\n'));
    // Set close, so the page fits on one sheet as the approved one does.
    const totals = layout.blocks.at(-1);
    expect(
      totals?.kind === 'boxes' && totals.right[0]?.kind === 'table'
        ? totals.right[0].dense
        : undefined,
    ).toBe(true);
  });

  it('DOC-076 lo que no se conoce no se imprime: sin comprador-paciente no hay dirección ni teléfono', () => {
    const text = wholeText(
      composeLayout(
        {
          kind: 'INVOICE_RIDE',
          data: {
            ...ride.data,
            buyerAddress: null,
            patient: { ...ride.data.patient!, phone: null },
          },
        },
        context,
        template,
      ),
    );
    expect(text).not.toContain('Dirección=');
    expect(text).not.toContain('Teléfono=');
    expect(text).toContain('Paciente=');
  });

  it('SRI-070 la autorización lleva fecha Y hora, en la de Guayaquil', () => {
    // 01:05 UTC of the 21st is 20:05 of the 20th in Ecuador: the day changes.
    expect(wholeText(composeLayout(ride, context, template))).toContain(
      'FECHA Y HORA DE AUTORIZACIÓN=20/08/2026 20:05:00',
    );
  });

  it('DOC-077 imprime las banderas fiscales que el establecimiento tiene puestas', () => {
    const text = wholeText(composeLayout(ride, context, template));
    expect(text).toContain('OBLIGADO A LLEVAR CONTABILIDAD=SÍ');
    expect(text).toContain('CONTRIBUYENTE ESPECIAL Nro.=1234');
    expect(text).toContain('AGENTE DE RETENCIÓN Resolución No.=5678');
    expect(text).toContain('RÉGIMEN RIMPE=EMPRENDEDOR');
  });

  it('DOC-077 omite las banderas que no aplican, en vez de imprimir «NO»', () => {
    const plain = composeLayout(
      ride,
      {
        ...context,
        establishment: {
          ...context.establishment,
          keepsAccounting: false,
          specialTaxpayerResolution: null,
          withholdingAgentResolution: null,
          rimpeRegime: 'NONE',
          tradeName: null,
          email: null,
          operatingPermit: null,
        },
      },
      template,
    );
    const text = wholeText(plain);
    // «Obligado a llevar contabilidad» is a yes/no legend the SRI always
    // prints; the other three are only printed when they apply.
    expect(text).toContain('OBLIGADO A LLEVAR CONTABILIDAD=NO');
    expect(text).not.toContain('CONTRIBUYENTE ESPECIAL');
    expect(text).not.toContain('AGENTE DE RETENCIÓN');
    expect(text).not.toContain('RIMPE');
  });

  it('DOC-077 dice NEGOCIO POPULAR cuando ése es el régimen', () => {
    const popular = composeLayout(
      ride,
      {
        ...context,
        establishment: {
          ...context.establishment,
          rimpeRegime: 'POPULAR_BUSINESS',
          tradeName: null,
          email: null,
          operatingPermit: null,
        },
      },
      template,
    );
    expect(wholeText(popular)).toContain('RÉGIMEN RIMPE=NEGOCIO POPULAR');
  });

  it('DOC-078 lleva la clave en código de barras bajo la clave en texto, y nunca QR', () => {
    const blocksOf = (layout: ReturnType<typeof composeLayout>) => {
      const found: Block[] = [];
      const walk = (blocks: readonly Block[]): void => {
        for (const block of blocks) {
          found.push(block);
          if (block.kind === 'boxes') {
            walk(block.left);
            walk(block.right);
          }
        }
      };
      walk(layout.blocks);
      return found;
    };

    const keyed = composeLayout(
      { kind: 'INVOICE_RIDE', data: { ...ride.data, accessKey: KEY_IN_TESTS } },
      context,
      template,
    );
    expect(blocksOf(keyed)).toContainEqual({
      kind: 'barcode',
      value: KEY_IN_TESTS,
    });
    expect(wholeText(keyed).toLowerCase()).not.toContain('qr');

    // Without a key there is nothing to encode, and nothing is invented.
    const unkeyed = composeLayout(
      { kind: 'INVOICE_RIDE', data: { ...ride.data, accessKey: null } },
      context,
      template,
    );
    expect(blocksOf(unkeyed).map((b) => b.kind)).not.toContain('barcode');
  });

  it('SRI-071 mientras el SRI no autoriza dice «PENDIENTE DE AUTORIZACIÓN» y no inventa número ni fecha', () => {
    const pending = composeLayout(
      {
        kind: 'INVOICE_RIDE',
        data: { ...ride.data, accessKey: KEY_IN_TESTS, authorisedAt: null },
      },
      context,
      template,
    );
    const text = wholeText(pending);
    expect(text).toContain('NÚMERO DE AUTORIZACIÓN=PENDIENTE DE AUTORIZACIÓN');
    expect(text).toContain(
      'FECHA Y HORA DE AUTORIZACIÓN=PENDIENTE DE AUTORIZACIÓN',
    );
    // SRI-070. The key is printed anyway: the RIDE is handed over with it.
    expect(text).toContain(`CLAVE DE ACCESO=${KEY_IN_TESTS}`);
  });

  it('SRI-071 una factura que el SRI devolvió o no autorizó no promete una autorización', () => {
    const refused = wholeText(
      composeLayout(
        {
          kind: 'INVOICE_RIDE',
          data: {
            ...ride.data,
            accessKey: KEY_IN_TESTS,
            authorisedAt: null,
            status: 'REJECTED',
          },
        },
        context,
        template,
      ),
    );
    expect(refused).toContain(
      'NÚMERO DE AUTORIZACIÓN=NO AUTORIZADA POR EL SRI',
    );
    expect(refused).not.toContain('PENDIENTE DE AUTORIZACIÓN');
  });

  it('SRI-070 imprime el ambiente que dice la clave, no «PRODUCCIÓN» por defecto', () => {
    const testing = wholeText(
      composeLayout(
        {
          kind: 'INVOICE_RIDE',
          data: { ...ride.data, accessKey: KEY_IN_TESTS },
        },
        context,
        template,
      ),
    );
    expect(testing).toContain('AMBIENTE=PRUEBAS');

    const production = `${KEY_IN_TESTS.slice(0, 23)}2${KEY_IN_TESTS.slice(24)}`;
    expect(
      wholeText(
        composeLayout(
          {
            kind: 'INVOICE_RIDE',
            data: { ...ride.data, accessKey: production },
          },
          context,
          template,
        ),
      ),
    ).toContain('AMBIENTE=PRODUCCIÓN');
  });

  it('DOC-076 sin clave todavía imprime «—», sin inventar una', () => {
    const unprepared = composeLayout(
      {
        kind: 'INVOICE_RIDE',
        data: { ...ride.data, accessKey: null, authorisedAt: null },
      },
      context,
      template,
    );
    const text = wholeText(unprepared);
    expect(text).toContain('CLAVE DE ACCESO=—');
    expect(text).not.toContain('4444');
  });
});

/** A key whose 24th digit says «pruebas», as `sri` composes them. */
const KEY_IN_TESTS = '3009202601179000156300110010010000001230045678911';
