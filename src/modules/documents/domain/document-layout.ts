import {
  NA,
  type NotApplicable,
} from '../../../shared/domain/form-117/form-117';
import type { DateInNumbersAndWords } from '../../../shared/domain/form-117/date-in-words';
import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import { DOCUMENT_TITLE } from './document-kind';
import {
  OUTPATIENT_VALIDITY_DAYS,
  ageText,
  quantityText,
  indicationsText,
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
      // D-095. HEADERS OF ONE LINE: the header row is one line high, and the
      // sample showed «Presentación y concentración» wrapping onto the first
      // value. The posology carries dose, frequency AND duration, so it gets
      // the room the DCI does not need.
      columns: [
        { header: '#', width: 0.04, align: 'right' },
        { header: 'Medicamento (DCI)', width: 0.24 },
        { header: 'Forma y concentración', width: 0.2 },
        { header: 'Vía', width: 0.12 },
        { header: 'Cantidad', width: 0.14 },
        { header: 'Posología', width: 0.26 },
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
  // PR-037. EVERY line, composed: the dose and the duration are what the
  // patient needs at home, whether or not the doctor added a remark.
  const indications = data.lines.map((line, index) => ({
    index: index + 1,
    text: indicationsText(line),
  }));

  /**
   * PR-020. The number first —it is what the ACESS reads to detect a gap—
   * and the pharmacy's check code beside it, each with its own name. A draft
   * previewed before the issue has neither, and says so instead of «null».
   */
  const reference =
    data.sequenceNumber === null || data.verificationCode === null
      ? 'Borrador — sin número'
      : `Receta N.º ${data.sequenceNumber} · Código de verificación: ${data.verificationCode}`;

  /**
   * PR-038, PR-039. Art. 5.e — what the PATIENT takes home, so it travels in
   * the detachable band. Demanded at the issue, so on an issued receta these
   * are never empty; a draft preview prints the gap with a dash.
   */
  const patientIndications: Block = {
    kind: 'fields',
    columns: 1,
    entries: [
      { label: 'Signos de alarma', value: data.warningSigns ?? '—' },
      {
        // PR-040. Beside the warning signs, because it is who to call.
        label: 'Teléfono del profesional',
        value: data.prescriber.contactPhone ?? '—',
      },
      {
        label: 'Recomendaciones no farmacológicas',
        value: data.nonPharmacologicalAdvice ?? '—',
      },
    ],
  };

  return {
    title: DOCUMENT_TITLE.PRESCRIPTION,
    reference,
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
        patientIndications,
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

/** How the request names its category: never the enum a clinician cannot read. */
const ORDER_CATEGORY_LABEL: Record<string, string> = {
  LABORATORY: 'Laboratorio',
  IMAGING: 'Imagen',
  PROCEDURE: 'Procedimiento',
};

const ORDER_PRIORITY_LABEL: Record<string, string> = {
  ROUTINE: 'Rutina',
  URGENT: 'Urgente',
  STAT: 'Inmediata',
};

/**
 * DOC-072. The exam request. No norm fixes its format.
 *
 * ORD-006. ITS NUMBER IS THE REFERENCE: the A.M. 00002393 art. 43 asks for
 * orders «codificadas de manera consecutiva», and the number is what a report
 * that comes back on paper quotes.
 */
export function composeServiceOrderLayout(
  data: ServiceOrderPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  // What the patient has to do before the extraction, once per distinct
  // instruction: an unstated fast is a second puncture (ORD-010).
  const preparations = [
    ...new Set(
      data.items
        .map((item) => item.preparation)
        .filter((text): text is string => text !== null && text.trim() !== ''),
    ),
  ];

  const blocks: Block[] = [
    {
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Fecha', value: ecuadorianDate(data.requestedAt) },
        {
          label: 'Tipo',
          value: ORDER_CATEGORY_LABEL[data.category] ?? data.category,
        },
        {
          label: 'Prioridad',
          value: ORDER_PRIORITY_LABEL[data.priority] ?? data.priority,
        },
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
        ...(data.clinicalNoteText === null
          ? []
          : [
              {
                label: 'Datos clínicos para el laboratorio',
                value: data.clinicalNoteText,
              },
            ]),
      ],
    },
    { kind: 'heading', text: 'Exámenes solicitados' },
    {
      kind: 'table',
      columns: [
        { header: 'Código', width: 0.28 },
        { header: 'Examen', width: 0.44 },
        { header: 'Muestra', width: 0.28 },
      ],
      rows: data.items.map((item) => [
        item.code,
        item.display,
        item.specimen ?? '—',
      ]),
    },
    { kind: 'heading', text: 'Indicaciones al paciente' },
    preparations.length === 0
      ? { kind: 'paragraph', text: 'No requiere preparación previa.' }
      : {
          kind: 'fields',
          columns: 1,
          entries: preparations.map((text) => ({
            label: 'Preparación',
            value: text,
          })),
        },
    { kind: 'heading', text: 'Médico solicitante' },
    prescriberBlock(data.orderedBy),
    {
      kind: 'signature',
      caption: 'Firma y sello del profesional',
      image: data.orderedBy.seal !== null ? 'seal' : null,
    },
  ];

  return {
    title: DOCUMENT_TITLE.SERVICE_ORDER,
    // ORD-006 and D-095: the number, and the code a laboratory checks the
    // order with.
    reference: `Orden N.º ${data.number} · Código de verificación: ${data.verificationCode}`,
    accentColour: template.accentColour,
    header: headerOf(context, template),
    blocks,
    tearOff: null,
    footerText: template.footerText,
  };
}

/** How a date of form 117 prints: «21/05/2026 — veintiuno de mayo de …». */
function form117Date(value: DateInNumbersAndWords | NotApplicable): string {
  if (value === NA) return NA;
  return `${value.iso.split('-').reverse().join('/')} — ${value.inWords}`;
}

/** The type of certificate in Spanish: never the enum (D-095). */
const CERTIFICATE_TYPE_LABEL: Record<string, string> = {
  ATTENDANCE: 'Certificado de asistencia',
  MEDICAL_REST: 'Reposo médico',
};

/**
 * DOC-075. The certificate over the structure of MSP form 117 —blocks A to E
 * with their own titles— plus what the IESS asks for (D-075) and the approved
 * template (D-095).
 *
 * THE CONTENT IS `composeForm117`'s, the same the screen serves: this function
 * only lays it out. Nothing here re-derives an age, a date in words or a
 * number of days.
 *
 * ⚠️ «CONFIDENCIAL» exactly when the diagnosis is printed (CER-033, A.M.
 * 5216-A art. 33). The header and footer are the common frame's
 * (`feat/documentos-identidad`); until it lands, the legend goes at the top of
 * the body.
 */
export function composeCertificateLayout(
  data: CertificatePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const form = data.form;
  const blocks: Block[] = [];

  if (form.confidential) {
    blocks.push({ kind: 'paragraph', text: 'CONFIDENCIAL', emphasis: true });
  }
  if (form.revocation !== null) {
    // A revoked certificate that printed like a valid one is the failure this
    // line exists for: somebody is holding the paper.
    blocks.push({
      kind: 'paragraph',
      text: `DOCUMENTO ANULADO el ${form.revocation.revokedOn.split('-').reverse().join('/')}: ${form.revocation.reason}. No tiene validez.`,
      emphasis: true,
    });
  }

  blocks.push(
    {
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Lugar de emisión', value: form.placeOfIssue },
        {
          label: 'Tipo',
          value: CERTIFICATE_TYPE_LABEL[form.type] ?? NA,
        },
        { label: 'Contingencia', value: form.contingency },
      ],
    },
    { kind: 'rule' },

    // ── A. Datos del establecimiento y usuario / paciente.
    {
      kind: 'heading',
      text: 'A. Datos del establecimiento y usuario / paciente',
    },
    {
      kind: 'fields',
      columns: 3,
      entries: [
        {
          label: 'Institución del sistema',
          value: form.establishment.institution,
        },
        { label: 'Unicódigo', value: form.establishment.mspUnicode },
        { label: 'Establecimiento de salud', value: form.establishment.name },
        {
          label: 'Número de historia clínica única',
          value: form.establishment.clinicalRecordNumber,
        },
        { label: 'Número de archivo', value: form.establishment.archiveNumber },
      ],
    },

    // ── B. Certifico que.
    { kind: 'heading', text: 'B. Certifico que' },
    {
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Primer apellido', value: form.patient.firstFamilyName },
        { label: 'Segundo apellido', value: form.patient.secondFamilyName },
        { label: 'Primer nombre', value: form.patient.firstGivenName },
        { label: 'Segundo nombre', value: form.patient.secondGivenName },
        { label: 'Sexo', value: form.patient.sex },
        {
          label: 'Edad',
          value: `${form.patient.age.value} (${form.patient.age.condition})`,
        },
        {
          label: 'Fue atendido en el servicio de',
          value: form.attention.service,
        },
        { label: 'Especialidad', value: form.attention.specialty },
        { label: 'Fecha de atención', value: form117Date(form.attention.date) },
        {
          label: 'Hora de atención',
          value: `desde ${form.attention.from} hasta ${form.attention.to}`,
        },
        { label: 'Fecha de ingreso', value: form.attention.admissionDate },
        { label: 'Fecha de alta', value: form.attention.dischargeDate },
      ],
    },
  );

  // ── C. Se recomienda.
  blocks.push(
    { kind: 'heading', text: 'C. Se recomienda' },
    {
      kind: 'fields',
      columns: 2,
      entries: [
        { label: 'Reposo', value: form.rest.rest },
        {
          label: 'Días de reposo',
          value:
            form.rest.days === NA
              ? NA
              : `${form.rest.days} (${form.rest.daysInWords})`,
        },
        { label: 'Desde', value: form117Date(form.rest.from) },
        { label: 'Hasta', value: form117Date(form.rest.to) },
      ],
    },
  );
  if (form.rest.periodInWords !== NA) {
    blocks.push({ kind: 'paragraph', text: form.rest.periodInWords });
  }
  if (form.maternity !== NA) {
    blocks.push({
      kind: 'fields',
      columns: 3,
      entries: [
        { label: 'Fecha de ingreso', value: form117Date(form.maternity.admission) }, // prettier-ignore
        { label: 'Fecha del parto', value: form117Date(form.maternity.birth) },
        {
          label: 'Fecha de alta',
          value: form117Date(form.maternity.discharge),
        },
      ],
    });
  }

  // ── D. Diagnóstico, con su código CIE, o «NA».
  blocks.push({ kind: 'heading', text: 'D. Diagnóstico' });
  blocks.push(
    form.diagnoses === NA
      ? { kind: 'paragraph', text: NA }
      : {
          kind: 'table',
          columns: [
            { header: 'CIE', width: 0.18 },
            { header: 'Diagnóstico', width: 0.82 },
          ],
          rows: form.diagnoses.map((d) => [d.code, d.display]),
        },
  );

  // ── E. Datos del profesional responsable.
  blocks.push(
    { kind: 'heading', text: 'E. Datos del profesional responsable' },
    {
      kind: 'fields',
      columns: 3,
      entries: [
        {
          label: 'Fecha',
          value: form.professional.date,
        },
        { label: 'Hora', value: form.professional.time },
        {
          label: 'Nombres y apellidos',
          value: `${form.professional.givenNames} ${form.professional.familyNames}`,
        },
        {
          label: 'Número de documento de identificación',
          value: form.professional.identification,
        },
      ],
    },
    {
      // CER-028. The credential signed it; the box is for the seal, never a
      // drawn stroke.
      kind: 'signature',
      caption: 'Firma (credencial del profesional en el sistema) y sello',
      image: data.issuedBy.seal !== null ? 'seal' : null,
    },
  );

  return {
    title: DOCUMENT_TITLE.MEDICAL_CERTIFICATE,
    reference: `Certificado N.º ${form.number} · Código de verificación: ${form.verificationCode}`,
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
    reference: `N.º ${data.documentNumber}`,
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
