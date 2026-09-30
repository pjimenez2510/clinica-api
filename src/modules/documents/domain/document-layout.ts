import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import { DOCUMENT_TITLE } from './document-kind';
import {
  OUTPATIENT_VALIDITY_DAYS,
  ageText,
  quantityText,
  routeText,
} from './prescription-wording';
import type { DocumentTemplate } from './document-template';
import type {
  CertificatePrintData,
  DocumentContext,
  DocumentSubject,
  InvoicePrintData,
  PatientIdentity,
  PractitionerIdentity,
  PrescriptionPrintData,
  ServiceOrderPrintData,
} from './document-source';
import type {
  Block,
  DocumentHeader,
  DocumentLayout,
  LabelledValue,
} from './page-layout';

/**
 * DOC-070 to DOC-078. The four documents, composed into a layout.
 *
 * PURE, AND THE INSTANT ARRIVES AS A PARAMETER. That is the only way DOC-073
 * and the validity of arts. 17–19 can be exercised under two time zones — and
 * a clinical date resolved with the session's zone is a day off for everything
 * issued after 19:00 in Ecuador.
 */

/** Every clinical date on every one of these documents, as a person reads it. */
function ecuadorianDate(instant: Date): string {
  const [year, month, day] = clinicalDateOf(instant).split('-');
  return `${day}/${month}/${year}`;
}

/** `2026-05-11` → `11/05/2026`, for a column that is already a calendar date. */
function calendarDate(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * DOC-071. The header repeated on every page: the establishment's name always,
 * and RUC, address and phone only when the template's switches ask for them
 * (DOC-034).
 */
function headerOf(
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentHeader {
  const { establishment } = context;
  return {
    establishmentName: establishment.name,
    // DOC-034. Read always, printed only when the clinic asked for it: art. 5
    // requires none of these three.
    establishmentRuc: template.showEstablishmentRuc ? establishment.ruc : null,
    establishmentAddress: template.showEstablishmentAddress
      ? establishment.addressLine
      : null,
    establishmentPhone: template.showEstablishmentPhone
      ? establishment.phone
      : null,
    hasLogo: establishment.logo !== null,
    fields: template.headerFields.map((field) => ({
      label: field.label,
      value: field.value,
    })),
  };
}

/**
 * The patient's block: name, identifying document when there is one, and age —
 * «—» when nobody recorded it.
 */
function patientBlock(patient: PatientIdentity): Block {
  const entries: LabelledValue[] = [
    { label: 'Apellidos y nombres', value: patient.fullName },
  ];
  if (patient.identifier !== null) {
    entries.push({ label: 'Documento', value: patient.identifier });
  }
  const age = ageText(patient.ageYears, patient.ageMonths);
  // DOC-060's sibling rule: an absent datum prints as an empty field, never as
  // an invented one. «—» says «nobody recorded this»; «0 años» would assert it.
  entries.push({ label: 'Edad', value: age ?? '—' });
  return { kind: 'fields', columns: 2, entries };
}

/**
 * Art. 5.d. The prescriber's name and ACESS registration, printed as «—» when
 * missing so the gap is visible.
 */
function prescriberBlock(prescriber: PractitionerIdentity): Block {
  return {
    kind: 'fields',
    columns: 2,
    entries: [
      { label: 'Profesional', value: prescriber.fullName },
      // Art. 5.d.ii. The number is printed ON the document, so an absent one is
      // a gap somebody has to see rather than a field quietly left out.
      {
        label: 'Registro ACESS',
        value: prescriber.acessRegistration ?? '—',
      },
    ],
  };
}

/**
 * DOC-072, DOC-073. The receta as art. 5 obliges it: five blocks, in order, and
 * the indications on a detachable band.
 */
export function composePrescriptionLayout(
  data: PrescriptionPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const issuedAt = data.issuedAt;
  const issuedDate = issuedAt === null ? null : clinicalDateOf(issuedAt);
  const validThrough =
    issuedDate === null
      ? null
      : addDays(issuedDate, OUTPATIENT_VALIDITY_DAYS - 1);

  const blocks: Block[] = [
    // ── Art. 5.a — datos generales.
    {
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Ciudad', value: data.city ?? '—' },
        {
          label: 'Fecha',
          value: issuedAt === null ? '—' : ecuadorianDate(issuedAt),
        },
        {
          // Arts. 17–19. DERIVED, never typed: a validity somebody keys in is a
          // validity somebody can extend.
          label: 'Vigencia',
          value:
            validThrough === null
              ? '—'
              : `${OUTPATIENT_VALIDITY_DAYS} días — hasta el ${validThrough.split('-').reverse().join('/')}`,
        },
      ],
    },
    { kind: 'rule' },

    // ── Art. 5.b — datos del paciente.
    { kind: 'heading', text: 'Paciente' },
    patientBlock(data.patient),
    {
      kind: 'fields',
      columns: 1,
      entries: [
        {
          // Art. 5.b.iii.
          label: 'Diagnóstico',
          value:
            data.diagnoses.length === 0
              ? '—'
              : data.diagnoses
                  .map((d) => `${d.code} · ${d.display}`)
                  .join(' | '),
        },
        {
          // Art. 5.b.iv. «Ninguna conocida» and not an empty box: a blank says
          // nobody asked, and this field exists precisely to record that
          // somebody did.
          label: 'Antecedentes de alergias',
          value:
            data.allergies.length === 0
              ? 'Ninguna conocida'
              : data.allergies.join(', '),
        },
      ],
    },

    // ── Art. 5.c — datos del medicamento.
    { kind: 'heading', text: 'Prescripción' },
    {
      kind: 'table',
      columns: [
        { header: '#', width: 0.05, align: 'right' },
        { header: 'Medicamento (DCI)', width: 0.35 },
        { header: 'Presentación y concentración', width: 0.22 },
        { header: 'Vía', width: 0.13 },
        { header: 'Cantidad', width: 0.13 },
        { header: 'Posología', width: 0.12 },
      ],
      rows: data.lines.map((line, index) => [
        String(index + 1),
        line.genericName,
        [line.presentation, line.concentration].filter(Boolean).join(' '),
        // DOC-074. Spelled out, or blank. A code this system cannot name is a
        // code it must not print.
        routeText(line.routeCode) ?? '',
        quantityText(line.quantity),
        [
          line.doseText,
          line.frequencyText,
          line.durationDays === null ? null : `por ${line.durationDays} días`,
        ]
          .filter(Boolean)
          .join(' · '),
      ]),
    },
  ];

  const offFormulary = data.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.offFormularyJustification !== null);

  if (offFormulary.length > 0) {
    blocks.push({
      kind: 'fields',
      columns: 1,
      entries: offFormulary.map(({ line, index }) => ({
        label: `Justificación fuera del CNMB — línea ${index + 1}`,
        value: line.offFormularyJustification ?? '',
      })),
    });
  }

  // ── Art. 5.d — datos del prescriptor, con su sello (d.iii).
  blocks.push(
    { kind: 'heading', text: 'Prescriptor' },
    prescriberBlock(data.prescriber),
    {
      kind: 'signature',
      caption: 'Firma y sello del profesional',
      image: data.prescriber.seal !== null ? 'seal' : null,
    },
  );

  // ── Art. 5.e — indicaciones, en la banda desprendible, con el sello otra vez
  //    (e.iv). El art. 5 lo pide DOS veces y ésta es la segunda.
  const indications = data.lines
    .map((line, index) =>
      line.instructions === null
        ? null
        : { index: index + 1, text: line.instructions },
    )
    .filter(
      (entry): entry is { index: number; text: string } => entry !== null,
    );

  return {
    title: DOCUMENT_TITLE.PRESCRIPTION,
    reference: data.verificationCode,
    accentColour: template.accentColour,
    header: headerOf(context, template),
    blocks,
    tearOff: {
      caption: 'Indicaciones para el paciente — recorte por esta línea',
      identification: [
        { label: 'Paciente', value: data.patient.fullName },
        {
          label: 'Fecha',
          value: issuedAt === null ? '—' : ecuadorianDate(issuedAt),
        },
      ],
      blocks: [
        indications.length === 0
          ? { kind: 'paragraph', text: 'Sin indicaciones adicionales' }
          : {
              kind: 'fields',
              columns: 1,
              entries: indications.map((entry) => ({
                label: `Línea ${entry.index}`,
                value: entry.text,
              })),
            },
        {
          kind: 'signature',
          caption: 'Sello del profesional',
          image: data.prescriber.seal !== null ? 'seal' : null,
        },
      ],
    },
    footerText: template.footerText,
  };
}

/** DOC-072. The exam request. No norm fixes its format. */
export function composeServiceOrderLayout(
  data: ServiceOrderPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  return {
    title: DOCUMENT_TITLE.SERVICE_ORDER,
    reference: null,
    accentColour: template.accentColour,
    header: headerOf(context, template),
    blocks: [
      {
        kind: 'fields',
        columns: 3,
        entries: [
          { label: 'Fecha', value: ecuadorianDate(data.requestedAt) },
          { label: 'Categoría', value: data.category },
          { label: 'Prioridad', value: data.priority },
        ],
      },
      { kind: 'rule' },
      { kind: 'heading', text: 'Paciente' },
      patientBlock(data.patient),
      {
        kind: 'fields',
        columns: 1,
        entries: [
          {
            label: 'Diagnóstico presuntivo',
            value:
              data.diagnoses.length === 0
                ? '—'
                : data.diagnoses
                    .map((d) => `${d.code} · ${d.display}`)
                    .join(' | '),
          },
        ],
      },
      { kind: 'heading', text: 'Exámenes solicitados' },
      {
        kind: 'table',
        columns: [
          { header: '#', width: 0.08, align: 'right' },
          { header: 'Examen', width: 0.72 },
          { header: 'Estado', width: 0.2 },
        ],
        rows: data.items.map((item, index) => [
          String(index + 1),
          item.display,
          item.status,
        ]),
      },
      ...(data.clinicalNoteText === null
        ? []
        : ([
            {
              kind: 'fields',
              columns: 1,
              entries: [
                {
                  label: 'Información clínica para el laboratorio',
                  value: data.clinicalNoteText,
                },
              ],
            },
          ] as Block[])),
      { kind: 'heading', text: 'Profesional solicitante' },
      prescriberBlock(data.orderedBy),
      {
        kind: 'signature',
        caption: 'Firma y sello del profesional',
        image: data.orderedBy.seal !== null ? 'seal' : null,
      },
    ],
    tearOff: null,
    footerText: template.footerText,
  };
}

/**
 * DOC-075. The certificate, over the structure of MSP form 117.
 *
 * ⚠️ THE DIAGNOSIS IS PRINTED ONLY IF THE PATIENT SAID SO. `include_diagnosis`
 * defaults to false in the schema, and this is the document their EMPLOYER
 * reads: privacy by default is an LOPDP requirement, not a preference.
 */
export function composeCertificateLayout(
  data: CertificatePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const restEntries: LabelledValue[] = [];
  if (data.restFrom !== null && data.restTo !== null) {
    restEntries.push(
      { label: 'Reposo desde', value: calendarDate(data.restFrom) },
      { label: 'Reposo hasta', value: calendarDate(data.restTo) },
    );
  }

  const blocks: Block[] = [
    {
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Formulario', value: '117 — Certificado médico' },
        { label: 'Fecha de emisión', value: ecuadorianDate(data.issuedAt) },
        { label: 'Tipo', value: data.type },
      ],
    },
    { kind: 'rule' },
    { kind: 'heading', text: 'Paciente' },
    patientBlock(data.patient),
  ];

  if (restEntries.length > 0) {
    blocks.push({ kind: 'fields', columns: 2, entries: restEntries });
  }

  if (data.includeDiagnosis && data.diagnoses.length > 0) {
    blocks.push({
      kind: 'fields',
      columns: 1,
      entries: [
        {
          label: 'Diagnóstico',
          value: data.diagnoses
            .map((d) => `${d.code} · ${d.display}`)
            .join(' | '),
        },
      ],
    });
  }

  blocks.push(
    { kind: 'heading', text: 'Certificación' },
    { kind: 'paragraph', text: data.body },
  );

  if (data.revokedAt !== null) {
    // A revoked certificate that printed like a valid one is the failure this
    // line exists for: somebody is holding the paper.
    blocks.push({
      kind: 'paragraph',
      text: `DOCUMENTO ANULADO el ${ecuadorianDate(data.revokedAt)}. No tiene validez.`,
      emphasis: true,
    });
  }

  blocks.push(
    { kind: 'heading', text: 'Profesional' },
    prescriberBlock(data.issuedBy),
    {
      kind: 'signature',
      caption: 'Firma y sello del profesional',
      image: data.issuedBy.seal !== null ? 'seal' : null,
    },
    {
      kind: 'fields',
      columns: 1,
      entries: [
        {
          label: 'Código de verificación',
          value: data.verificationCode,
        },
      ],
    },
  );

  return {
    title: DOCUMENT_TITLE.MEDICAL_CERTIFICATE,
    reference: data.verificationCode,
    accentColour: template.accentColour,
    header: headerOf(context, template),
    blocks,
    tearOff: null,
    footerText: template.footerText,
  };
}

/** DOC-077. The fiscal legends, in the words the SRI's Anexo 2 prints. */
function fiscalLegends(context: DocumentContext): LabelledValue[] {
  const { establishment } = context;
  const legends: LabelledValue[] = [
    {
      label: 'OBLIGADO A LLEVAR CONTABILIDAD',
      value: establishment.keepsAccounting ? 'SÍ' : 'NO',
    },
  ];

  if (establishment.specialTaxpayerResolution !== null) {
    legends.push({
      label: 'CONTRIBUYENTE ESPECIAL Nro.',
      value: establishment.specialTaxpayerResolution,
    });
  }
  if (establishment.withholdingAgentResolution !== null) {
    legends.push({
      label: 'AGENTE DE RETENCIÓN Resolución No.',
      value: establishment.withholdingAgentResolution,
    });
  }
  if (establishment.rimpeRegime === 'ENTREPRENEUR') {
    legends.push({ label: 'RÉGIMEN RIMPE', value: 'EMPRENDEDOR' });
  }
  if (establishment.rimpeRegime === 'POPULAR_BUSINESS') {
    legends.push({ label: 'RÉGIMEN RIMPE', value: 'NEGOCIO POPULAR' });
  }

  return legends;
}

/**
 * DOC-076 to DOC-078. The RIDE, following the SRI's Ficha Técnica, Anexo 2.
 *
 * ⚠️ NO QR AND NO BARCODE, AND THAT IS A REQUIREMENT RATHER THAN AN OMISSION
 * (DOC-078). «QR» does not appear ONCE in the 142 pages of the Ficha Técnica,
 * and the barcode is explicitly optional. Both are what somebody would add from
 * memory after seeing other RIDEs, and an invented element on a tax document is
 * exactly what a review looks at.
 */
export function composeInvoiceLayout(
  data: InvoicePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const { establishment } = context;

  const issuerBox: Block[] = [
    { kind: 'paragraph', text: establishment.name, emphasis: true },
    ...(establishment.addressLine === null
      ? []
      : ([{ kind: 'paragraph', text: establishment.addressLine }] as Block[])),
    ...(establishment.phone === null
      ? []
      : ([{ kind: 'paragraph', text: establishment.phone }] as Block[])),
    { kind: 'fields', columns: 1, entries: fiscalLegends(context) },
  ];

  const voucherBox: Block[] = [
    {
      kind: 'fields',
      columns: 1,
      entries: [
        { label: 'R.U.C.', value: establishment.ruc ?? '—' },
        { label: 'FACTURA No.', value: data.documentNumber },
        // The access key IS the authorisation number for the offline scheme,
        // which is the one this system uses. Printing «—» while it is absent is
        // honest: an unauthorised RIDE is not yet a voucher.
        { label: 'NÚMERO DE AUTORIZACIÓN', value: data.accessKey ?? '—' },
        {
          label: 'FECHA Y HORA DE AUTORIZACIÓN',
          value:
            data.authorisedAt === null
              ? '—'
              : ecuadorianDate(data.authorisedAt),
        },
        { label: 'AMBIENTE', value: 'PRODUCCIÓN' },
        { label: 'EMISIÓN', value: 'NORMAL' },
        { label: 'CLAVE DE ACCESO', value: data.accessKey ?? '—' },
      ],
    },
  ];

  return {
    title: DOCUMENT_TITLE.INVOICE_RIDE,
    reference: data.documentNumber,
    accentColour: template.accentColour,
    header: headerOf(context, template),
    blocks: [
      { kind: 'boxes', left: issuerBox, right: voucherBox },
      { kind: 'heading', text: 'Datos del comprador' },
      {
        kind: 'fields',
        columns: 2,
        entries: [
          {
            label: 'Razón social / Apellidos y nombres',
            value: data.buyerName,
          },
          { label: 'Identificación', value: data.buyerIdentification },
          {
            label: 'Fecha de emisión',
            value: data.issuedAt === null ? '—' : ecuadorianDate(data.issuedAt),
          },
          { label: 'Correo', value: data.buyerEmail ?? '—' },
        ],
      },
      { kind: 'heading', text: 'Detalle' },
      {
        kind: 'table',
        columns: [
          { header: 'Cód.', width: 0.14 },
          { header: 'Descripción', width: 0.4 },
          { header: 'Cant.', width: 0.1, align: 'right' },
          { header: 'P. unitario', width: 0.12, align: 'right' },
          { header: 'Descuento', width: 0.12, align: 'right' },
          { header: 'Total', width: 0.12, align: 'right' },
        ],
        rows: data.lines.map((line) => [
          line.code,
          line.description,
          line.quantity,
          line.unitPrice,
          line.discount,
          line.total,
        ]),
      },
      {
        kind: 'fields',
        columns: 2,
        entries: [
          { label: 'SUBTOTAL 0%', value: data.subtotalUntaxed },
          { label: 'SUBTOTAL GRAVADO', value: data.subtotalTaxed },
          { label: 'DESCUENTO', value: data.discountTotal },
          { label: 'IVA', value: data.taxTotal },
          { label: 'VALOR TOTAL', value: data.total },
        ],
      },
    ],
    tearOff: null,
    footerText: template.footerText,
  };
}

/** The one entry point: a subject and a template in, a layout out. */
export function composeLayout(
  subject: DocumentSubject,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  switch (subject.kind) {
    case 'PRESCRIPTION':
      return composePrescriptionLayout(subject.data, context, template);
    case 'SERVICE_ORDER':
      return composeServiceOrderLayout(subject.data, context, template);
    case 'MEDICAL_CERTIFICATE':
      return composeCertificateLayout(subject.data, context, template);
    case 'INVOICE_RIDE':
      return composeInvoiceLayout(subject.data, context, template);
  }
}
