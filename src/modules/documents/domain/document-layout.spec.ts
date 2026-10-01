import { describe, expect, it } from 'vitest';
import {
  composeForm117,
  type Form117,
  type Form117Source,
} from '../../../shared/domain/form-117/form-117';
import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

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
  contactPhone: '0991234567',
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
    sequenceNumber: 120,
    warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
    nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
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

describe('DOC-072 la tabla de la receta, como la plantilla aprobada (D-095)', () => {
  /** The prescription table of the layout. */
  const tableOf = (layout: ReturnType<typeof composeLayout>) => {
    const table = layout.blocks.find((block) => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('no table');
    return table;
  };

  it('DOC-072 las columnas son DCI, forma y concentración, vía, cantidad y posología, con cabeceras de una línea', () => {
    const table = tableOf(composeLayout(prescription(), context, template));

    expect(table.columns.map((column) => column.header)).toEqual([
      '#',
      'Medicamento (DCI)',
      'Forma y concentración',
      'Vía',
      'Cantidad',
      'Posología',
    ]);
    // La fila de cabecera mide una línea: una cabecera que salta a dos se
    // monta sobre el valor, que es lo que se vio en la muestra.
    for (const column of table.columns) {
      expect(column.header.length / column.width).toBeLessThan(110);
    }
  });

  it('DOC-072 la posología tiene sitio para dosis, frecuencia y duración', () => {
    const table = tableOf(composeLayout(prescription(), context, template));
    const posology = table.columns.find(
      (column) => column.header === 'Posología',
    );

    expect(posology?.width).toBeGreaterThanOrEqual(0.26);
    expect(
      table.columns.reduce((sum, column) => sum + column.width, 0),
    ).toBeCloseTo(1);
    expect(table.rows[0]?.[5]).toBe('1 tableta · cada 8 horas · por 7 días');
  });
});

describe('PR-020 PR-038 PR-039 la receta impresa lleva su número y sus indicaciones', () => {
  it('PR-020 la referencia es el número de la receta, y el código de verificación va al pie', () => {
    const { frame } = composeLayout(prescription(), context, template);

    expect(frame.reference).toBe('Receta N.º 120');
    expect(frame.footer.verification?.code).toBe('RX-7Q2K');
  });

  it('PR-010 una receta anulada lo dice arriba y en cada página: no se dispensa', () => {
    const cancelled = composeLayout(
      prescription({ status: 'CANCELLED' }),
      context,
      template,
    );
    expect(cancelled.frame.watermark).toBe('RECETA ANULADA');
    expect(textOf(cancelled.blocks)).toContain('RECETA ANULADA');

    // Control positivo: la vigente no lleva ninguna marca.
    const active = composeLayout(prescription(), context, template);
    expect(active.frame.watermark).toBeNull();
    expect(textOf(active.blocks)).not.toContain('ANULADA');
  });

  it('PR-020 una previsualización de borrador no imprime «null» ni un número que no tiene', () => {
    const layout = composeLayout(
      prescription({ sequenceNumber: null, verificationCode: null }),
      context,
      template,
    );

    expect(layout.frame.reference).toBe('Borrador — sin número');
    expect(layout.frame.footer.verification).toBeNull();
  });

  it('PR-037 la banda lleva, de cada línea, sus indicaciones completas y sin abreviaturas', () => {
    const layout = composeLayout(prescription(), context, template);
    const tearOff = textOf(layout.tearOff?.blocks ?? []);

    expect(tearOff).toContain(
      'Amoxicilina 500 mg: 1 tableta, cada 8 horas, por vía oral, durante 7 días. Tomar con alimentos',
    );
  });

  it('PR-040 junto a los signos de alarma va el teléfono al que llamar, que es el del prescriptor', () => {
    const layout = composeLayout(prescription(), context, template);
    const tearOff = textOf(layout.tearOff?.blocks ?? []);

    expect(tearOff).toContain('Si aparece alguno, llame al 0991234567.');
  });

  it('PR-038 PR-039 los signos de alarma y las recomendaciones van en la banda que se lleva el paciente', () => {
    const layout = composeLayout(prescription(), context, template);
    const tearOff = textOf(layout.tearOff?.blocks ?? []);

    expect(tearOff).toContain('Signos de alarma');
    expect(tearOff).toContain(
      'Fiebre mayor de 39 °C o dificultad para respirar',
    );
    expect(tearOff).toContain('Recomendaciones no farmacológicas');
    expect(tearOff).toContain('Abundantes líquidos y reposo relativo');
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

  it('DOC-073 PR-037 la banda nunca queda vacía: una línea sin comentario lleva igual su frase compuesta', () => {
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
      'Amoxicilina: 1, cada día, por vía oral',
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
          number: 1,
          requestedAt: new Date('2026-08-21T01:00:00Z'),
          category: 'LABORATORY',
          priority: 'ROUTINE',
          clinicalNoteText: 'Paciente en ayunas',
          patient,
          diagnoses: [{ code: 'E11', display: 'Diabetes mellitus tipo 2' }],
          orderedBy: prescriber,
          verificationCode: 'OR-1A2B',
          items: [
            {
              code: 'EX-HBA1C',
              display: 'Hemoglobina glicosilada',
              specimen: 'Sangre total',
              preparation: null,
              status: 'REQUESTED',
            },
          ],
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

describe('ORD-006 DOC-072 la orden impresa, como la plantilla aprobada (D-095)', () => {
  const order = (
    overrides: Partial<
      Extract<DocumentSubject, { kind: 'SERVICE_ORDER' }>['data']
    > = {},
  ): DocumentSubject => ({
    kind: 'SERVICE_ORDER',
    data: {
      subjectId: 'order-1',
      siteId: 'site-1',
      number: 41,
      verificationCode: 'OR-9Z8Y',
      requestedAt: new Date(0),
      category: 'LABORATORY',
      priority: 'URGENT',
      clinicalNoteText: 'Paciente en tratamiento con metformina',
      patient,
      diagnoses: [{ code: 'E11', display: 'Diabetes mellitus tipo 2' }],
      orderedBy: prescriber,
      items: [
        {
          code: 'EX-GLUCOSA-AYUNAS',
          display: 'Glucosa en ayunas',
          specimen: 'Suero',
          preparation: 'Ayuno de 8 a 12 horas.',
          status: 'REQUESTED',
        },
        {
          code: 'EX-BH',
          display: 'Biometría hemática completa',
          specimen: 'Sangre total con EDTA',
          preparation: null,
          status: 'REQUESTED',
        },
      ],
      ...overrides,
    },
  });

  it('ORD-007 un examen cancelado no sale en el papel del laboratorio, y sin ninguno vivo la orden sale anulada', () => {
    const withOneCancelled = composeLayout(
      order({
        items: [
          { code: 'EX-GLUCOSA-AYUNAS', display: 'Glucosa en ayunas', specimen: 'Suero', preparation: 'Ayuno de 8 a 12 horas.', status: 'CANCELLED' }, // prettier-ignore
          { code: 'EX-BH', display: 'Biometría hemática completa', specimen: null, preparation: null, status: 'REQUESTED' }, // prettier-ignore
        ],
      }),
      context,
      template,
    );
    const text = wholeText(withOneCancelled);
    // Control positivo: el examen vivo sale.
    expect(text).toContain('Biometría hemática completa');
    expect(text).not.toContain('Glucosa en ayunas');
    expect(text).not.toContain('Ayuno de 8 a 12 horas');
    expect(withOneCancelled.frame.watermark).toBeNull();

    const allCancelled = composeLayout(
      order({
        items: [
          { code: 'EX-BH', display: 'Biometría hemática completa', specimen: null, preparation: null, status: 'CANCELLED' }, // prettier-ignore
        ],
      }),
      context,
      template,
    );
    expect(allCancelled.frame.watermark).toBe('ORDEN ANULADA');
    expect(wholeText(allCancelled)).toContain('ORDEN ANULADA');
  });

  it('ORD-006 la referencia es el número de la orden y su código de verificación va al pie', () => {
    const { frame } = composeLayout(order(), context, template);

    expect(frame.reference).toBe('Orden N.º 41');
    expect(frame.footer.verification?.code).toBe('OR-9Z8Y');
  });

  it('ORD-006 la categoría y la prioridad se imprimen en castellano, no como el enum', () => {
    const text = wholeText(composeLayout(order(), context, template));

    expect(text).toContain('Laboratorio');
    expect(text).toContain('Urgente');
    expect(text).not.toMatch(/LABORATORY|URGENT/);
  });

  it('DOC-072 la tabla es código, examen y muestra, y la preparación va en las indicaciones al paciente', () => {
    const layout = composeLayout(order(), context, template);
    const table = layout.blocks.find((block) => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('no table');

    expect(table.columns.map((column) => column.header)).toEqual([
      'Código',
      'Examen',
      'Muestra',
    ]);
    expect(table.rows[0]).toEqual(['EX-GLUCOSA-AYUNAS', 'Glucosa en ayunas', 'Suero']); // prettier-ignore
    const text = wholeText(layout);
    expect(text).toContain('Indicaciones al paciente');
    expect(text).toContain('Ayuno de 8 a 12 horas.');
  });

  it('DOC-072 los datos clínicos van para el laboratorio, con su nombre', () => {
    const text = wholeText(composeLayout(order(), context, template));

    expect(text).toContain('Datos clínicos para el laboratorio');
    expect(text).toContain('Paciente en tratamiento con metformina');
  });

  it('DOC-072 sin preparación que pedir, la orden lo dice en vez de dejar el bloque vacío', () => {
    const text = wholeText(
      composeLayout(
        order({
          items: [
            { code: 'EX-BH', display: 'Biometría hemática completa', specimen: null, preparation: null, status: 'REQUESTED' }, // prettier-ignore
          ],
        }),
        context,
        template,
      ),
    );

    expect(text).toContain('No requiere preparación');
  });
});

describe('DOC-075 el certificado sobre el formulario 117 y la plantilla aprobada (D-095)', () => {
  const now = new Date(0);
  const day = clinicalDateOf(now);

  /** A form 117 as `certificates` composes it, the same function the PDF uses. */
  const form = (
    certificate: Partial<Form117Source['certificate']> = {},
  ): Form117 =>
    composeForm117({
      certificate: {
        id: 'certificate-1',
        number: 7,
        verificationCode: 'CM-4T7',
        type: 'MEDICAL_REST',
        issuedAt: now,
        restFrom: day,
        restTo: addDays(day, 2),
        includeDiagnosis: true,
        contingencyType: 'GENERAL_ILLNESS',
        maternity: null,
        revokedAt: null,
        revocationReason: null,
        ...certificate,
      },
      site: {
        name: 'Sede Norte',
        mspUnicode: '000123',
        city: 'Quito',
        address: 'Av. Amazonas N24-10',
        phone: '022345678',
      },
      patient: {
        familyName: 'Guamán',
        secondFamilyName: 'Andrade',
        givenName: 'María',
        secondGivenName: 'José',
        sex: 'FEMALE',
        mrn: 'HC000042',
        employerName: 'Florícola del Valle',
        jobTitle: 'Supervisora de cultivo',
        residenceAddressLine: 'Calle Sucre 4-12',
        phone: '0991234567',
        identifiers: [{ type: 'CEDULA', value: '1710034065' }],
      },
      encounter: {
        startedAt: now,
        endedAt: null,
        ageYears: 34,
        ageMonths: 2,
        ageDays: 9,
      },
      diagnoses: [{ code: 'J00', display: 'Rinofaringitis aguda' }],
      practitioner: {
        givenNames: 'Rosa',
        familyNames: 'Cedeño',
        cedula: '1104637283',
        primarySpecialty: 'Medicina familiar',
        hasSeal: false,
      },
    });

  const certificate = (formData: Form117 = form()): DocumentSubject => ({
    kind: 'MEDICAL_CERTIFICATE',
    data: {
      subjectId: 'certificate-1',
      siteId: 'site-1',
      form: formData,
      issuedBy: prescriber,
    },
  });

  it('DOC-075 CER-020 CER-028 lleva los cinco bloques del 117, de la A a la E', () => {
    const headings = composeLayout(certificate(), context, template)
      .blocks.filter((block) => block.kind === 'heading')
      .map((block) => (block.kind === 'heading' ? block.text : ''));

    expect(headings).toEqual([
      'A. Datos del establecimiento y usuario / paciente',
      'B. Certifico que',
      'C. Se recomienda',
      'D. Diagnóstico',
      'E. Datos del profesional responsable',
    ]);
  });

  it('DOC-075 CER-038 el reposo imprime los datos laborales del paciente bajo el bloque B', () => {
    const layout = composeLayout(certificate(), context, template);
    const { blocks } = layout;
    const text = wholeText(layout);

    expect(text).toContain('Datos laborales del paciente');
    for (const value of [
      'Florícola del Valle',
      'Supervisora de cultivo',
      'Calle Sucre 4-12',
      '0991234567',
    ]) {
      expect(text).toContain(value);
    }

    // Bajo el bloque B y antes del C.
    const order = blocks.map((block) =>
      block.kind === 'heading'
        ? block.text
        : block.kind === 'paragraph'
          ? block.text
          : '',
    );
    const work = order.indexOf('Datos laborales del paciente');
    expect(work).toBeGreaterThan(order.indexOf('B. Certifico que'));
    expect(work).toBeLessThan(order.indexOf('C. Se recomienda'));
  });

  it('DOC-075 CER-038 el certificado de asistencia no imprime datos laborales', () => {
    const attendance = form({
      type: 'ATTENDANCE',
      restFrom: null,
      restTo: null,
      contingencyType: null,
      includeDiagnosis: false,
    });
    const text = wholeText(
      composeLayout(certificate(attendance), context, template),
    );
    expect(text).not.toContain('Datos laborales del paciente');
    expect(text).not.toContain('Florícola del Valle');
  });

  it('DOC-075 no imprime un enum en inglés ni un encabezado vacío', () => {
    const text = wholeText(composeLayout(certificate(), context, template));

    expect(text).not.toMatch(
      /MEDICAL_REST|ATTENDANCE|\bREST\b|GENERAL_ILLNESS/,
    );
    expect(text).not.toContain('Certificación');
    expect(text).toContain('Reposo médico');
  });

  it('CER-020 la sede y su unicódigo van en el bloque A, con la HC y el archivo', () => {
    const text = wholeText(composeLayout(certificate(), context, template));

    expect(text).toContain('Sede Norte');
    expect(text).toContain('000123');
    expect(text).toContain('1710034065');
    expect(text).toContain('HC000042');
  });

  it('CER-026 el reposo en días, en números y en letras, con la frase del período', () => {
    const text = wholeText(composeLayout(certificate(), context, template));

    expect(text).toContain('3 (tres)');
    expect(text).toContain('ambas fechas incluidas');
    expect(text).not.toMatch(/horas/i);
  });

  it('CER-033 lleva la leyenda CONFIDENCIAL cuando imprime el diagnóstico, y no cuando no', () => {
    const withDiagnosis = composeLayout(certificate(), context, template);
    const without = composeLayout(
      certificate(
        form({ type: 'ATTENDANCE', restFrom: null, restTo: null, includeDiagnosis: false, contingencyType: null }), // prettier-ignore
      ),
      context,
      template,
    );

    // The common frame prints the legend beside the title (DOC-082).
    expect(withDiagnosis.frame.confidential).toBe(true);
    expect(wholeText(withDiagnosis)).toContain('J00');
    expect(without.frame.confidential).toBe(false);
    expect(wholeText(without)).not.toContain('J00');
  });

  it('CER-034 CER-036 la contingencia y el lugar de emisión', () => {
    const text = wholeText(composeLayout(certificate(), context, template));

    expect(text).toContain('Enfermedad general');
    expect(text).toContain('Quito');
  });

  it('CER-035 en maternidad imprime ingreso, parto y alta', () => {
    const text = wholeText(
      composeLayout(
        certificate(
          form({
            contingencyType: 'MATERNITY',
            maternity: { admissionOn: day, birthOn: day, dischargeOn: addDays(day, 2) }, // prettier-ignore
          }),
        ),
        context,
        template,
      ),
    );

    expect(text).toContain('Fecha de ingreso');
    expect(text).toContain('Fecha del parto');
    expect(text).toContain('Fecha de alta');
  });

  it('CER-042 el certificado anulado imprime sólo «ANULADO el DD/MM/AAAA», nunca el motivo', () => {
    const reason = 'Era F32, no J06: motivo centinela';
    const layout = composeLayout(
      certificate(form({ revokedAt: now, revocationReason: reason })),
      context,
      template,
    );
    const text = wholeText(layout);

    const revokedOn = clinicalDateOf(now).split('-').reverse().join('/');
    expect(text).toContain(`ANULADO el ${revokedOn}. No tiene validez.`);
    expect(text).not.toContain('Era F32');
    expect(JSON.stringify(layout)).not.toContain('motivo centinela');
  });

  it('CER-029 un certificado anulado lo dice en el propio papel, y en cada página', () => {
    const layout = composeLayout(
      certificate(form({ revokedAt: now, revocationReason: 'Se emitió a otro paciente' })), // prettier-ignore
      context,
      template,
    );

    expect(wholeText(layout)).toContain('ANULADO');
    expect(layout.frame.watermark).toBe('CERTIFICADO ANULADO');
    // Control positivo: el vigente no lleva marca.
    expect(
      composeLayout(certificate(), context, template).frame.watermark,
    ).toBeNull();
  });

  it('CER-029 la referencia es el número del certificado y su código de verificación va al pie', () => {
    const { frame } = composeLayout(certificate(), context, template);

    expect(frame.reference).toBe('Certificado N.º 7');
    expect(frame.footer.verification?.code).toBe('CM-4T7');
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
