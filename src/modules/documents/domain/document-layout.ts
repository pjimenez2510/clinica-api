import {
  addDays,
  clinicalDateOf,
  wallClockOf,
} from '../../../shared/domain/clinic-time';

import { composeFrame } from './document-frame';
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
import type { Block, DocumentLayout, LabelledValue } from './page-layout';

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

/** SRI-070. The authorisation is an instant: date and wall-clock time in Ecuador. */
function ecuadorianDateTime(instant: Date): string {
  const time = wallClockOf(instant);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${ecuadorianDate(instant)} ${two(time.hour)}:${two(time.minute)}:${two(time.second)}`;
}

/** `2026-05-11` → `11/05/2026`, for a column that is already a calendar date. */
function calendarDate(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
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
    frame: composeFrame(context, template, {
      kind: 'PRESCRIPTION',
      reference: data.verificationCode,
      confidential: data.diagnoses.length > 0,
      verificationCode: data.verificationCode,
    }),
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
  };
}

/** DOC-072. The exam request. No norm fixes its format. */
export function composeServiceOrderLayout(
  data: ServiceOrderPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  return {
    frame: composeFrame(context, template, {
      kind: 'SERVICE_ORDER',
      reference: null,
      confidential: data.diagnoses.length > 0,
      verificationCode: null,
    }),
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
    frame: composeFrame(context, template, {
      kind: 'MEDICAL_CERTIFICATE',
      reference: data.verificationCode,
      // DOC-082. Only when the patient let the diagnosis be printed.
      confidential: data.includeDiagnosis && data.diagnoses.length > 0,
      verificationCode: data.verificationCode,
    }),
    blocks,
    tearOff: null,
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

/** SRI-071. What the RIDE says while the SRI has not authorised. */
const PENDING_AUTHORISATION = 'PENDIENTE DE AUTORIZACIÓN';
/** SRI-071, D-102. What it says once the SRI returned or refused it. */
const NOT_AUTHORISED = 'NO AUTORIZADA POR EL SRI';

/** SRI-070. The 24th digit of the access key: `1` pruebas, `2` producción. */
function environmentOf(accessKey: string | null): string {
  if (accessKey === null || accessKey.length !== 49) return '—';
  return accessKey[23] === '2' ? 'PRODUCCIÓN' : 'PRUEBAS';
}

/**
 * DOC-076 to DOC-078. The RIDE, following the SRI's Ficha Técnica, Anexo 2.
 *
 * ⚠️ NO QR (DOC-078). «QR» does not appear ONCE in the 142 pages of the Ficha
 * Técnica; it is what somebody would add from memory after seeing other RIDEs,
 * and an invented element on a tax document is exactly what a review looks at.
 *
 * The barcode the Ficha does allow (§9.20–9.21, Anexo 2) is the access key in
 * Code 128 subset C, without a GS1 application identifier (D-095 §5): the
 * `barcode` block, right under the key in text in the voucher's box.
 */
export function composeInvoiceLayout(
  data: InvoicePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  // SRI-071. Pending only while it can still be authorised: a returned or
  // refused invoice must not promise an authorisation that will not come.
  const unauthorised =
    data.status === 'REJECTED' ? NOT_AUTHORISED : PENDING_AUTHORISATION;
  const { establishment } = context;

  // DOC-076. The issuer's box of the approved page «Factura» (D-095): legal
  // name, trade name, head office and establishment addresses, and the fiscal
  // legends that apply. The logo, when there is one, is the frame's, above it.
  const issuerBox: Block[] = [
    { kind: 'paragraph', text: establishment.name, emphasis: true },
    ...(establishment.tradeName === null ||
    establishment.tradeName === establishment.name
      ? []
      : ([{ kind: 'paragraph', text: establishment.tradeName }] as Block[])),
    {
      kind: 'fields',
      columns: 1,
      entries: [
        ...(establishment.headOfficeAddress === null
          ? []
          : [
              {
                label: 'DIRECCIÓN MATRIZ',
                value: establishment.headOfficeAddress,
              },
            ]),
        ...(establishment.addressLine === null ||
        establishment.addressLine === establishment.headOfficeAddress
          ? []
          : [
              {
                label: 'DIRECCIÓN ESTABLECIMIENTO',
                value: establishment.addressLine,
              },
            ]),
        ...fiscalLegends(context),
      ],
    },
  ];

  const voucherBox: Block[] = [
    {
      kind: 'fields',
      columns: 1,
      entries: [
        { label: 'R.U.C.', value: establishment.ruc ?? '—' },
        { label: 'FACTURA No.', value: data.documentNumber },
        // The access key IS the authorisation number for the offline scheme.
        // SRI-071: until the SRI authorises, the RIDE is handed over saying
        // so — never a number or a date that does not exist yet.
        {
          label: 'NÚMERO DE AUTORIZACIÓN',
          value:
            data.authorisedAt === null ? unauthorised : (data.accessKey ?? '—'),
        },
        {
          label: 'FECHA Y HORA DE AUTORIZACIÓN',
          value:
            data.authorisedAt === null
              ? unauthorised
              : ecuadorianDateTime(data.authorisedAt),
        },
        // SRI-070. The environment is the one written INSIDE the key (its 24th
        // digit), never a constant: a test voucher printed «PRODUCCIÓN» claims
        // a validity it does not have.
      ],
    },
    // Ambiente and emisión share a row, as on the approved page.
    {
      kind: 'fields',
      columns: 2,
      entries: [
        { label: 'AMBIENTE', value: environmentOf(data.accessKey) },
        { label: 'EMISIÓN', value: 'NORMAL' },
      ],
    },
    {
      kind: 'fields',
      columns: 1,
      entries: [{ label: 'CLAVE DE ACCESO', value: data.accessKey ?? '—' }],
    },
    // D-095 §5, DOC-078. The key again, as a Code 128 subset C barcode under
    // the key in text — only when there is a key to encode.
    ...(data.accessKey === null
      ? []
      : [{ kind: 'barcode' as const, value: data.accessKey }]),
  ];

  // DOC-076 «Información adicional»: what the voucher's own fields do not say.
  const additional: LabelledValue[] = [
    ...(data.buyerEmail === null
      ? []
      : [{ label: 'Correo', value: data.buyerEmail }]),
    ...(data.patient?.phone
      ? [{ label: 'Teléfono', value: data.patient.phone }]
      : []),
    ...(data.patient === null
      ? []
      : [
          {
            label: 'Paciente',
            // The HC as it is quoted: its number already says «HC».
            value: `${data.patient.fullName} · ${data.patient.mrn}`,
          },
        ]),
    ...(data.attendedOn === null
      ? []
      : [
          {
            label: 'Atención',
            value: `${calendarDate(data.attendedOn)} · ${context.siteName}`,
          },
        ]),
  ];

  const sums = invoiceSubtotals(data);

  return {
    frame: composeFrame(context, template, {
      kind: 'INVOICE_RIDE',
      reference: data.documentNumber,
      confidential: false,
      verificationCode: null,
    }),
    blocks: [
      { kind: 'boxes', left: issuerBox, right: voucherBox },
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
          ...(data.buyerAddress === null
            ? []
            : [{ label: 'Dirección', value: data.buyerAddress }]),
        ],
      },
      {
        kind: 'table',
        columns: [
          { header: 'Cód. principal', width: 0.13 },
          { header: 'Cód. auxiliar', width: 0.1 },
          { header: 'Cant.', width: 0.07, align: 'right' },
          { header: 'Descripción', width: 0.34 },
          { header: 'Precio unitario', width: 0.12, align: 'right' },
          { header: 'Descuento', width: 0.11, align: 'right' },
          { header: 'Precio total', width: 0.13, align: 'right' },
        ],
        rows: data.lines.map((line) => [
          line.code,
          line.auxiliaryCode ?? '—',
          line.quantity,
          line.description,
          line.unitPrice,
          line.discount,
          line.total,
        ]),
      },
      {
        kind: 'boxes',
        left: [
          ...(additional.length === 0
            ? []
            : ([
                {
                  kind: 'paragraph',
                  text: 'Información adicional',
                  emphasis: true,
                },
                { kind: 'fields', columns: 1, entries: additional },
              ] as Block[])),
          // BI-170. The way it was paid, with its SRI table 24 code.
          {
            kind: 'table',
            columns: [
              { header: 'Forma de pago', width: 0.7 },
              { header: 'Valor', width: 0.3, align: 'right' },
            ],
            rows: [
              [
                data.paymentMethod === null
                  ? '—'
                  : `${data.paymentMethod} · ${PAYMENT_METHOD_LABEL[data.paymentMethod] ?? data.paymentMethod}`,
                data.total,
              ],
            ],
          },
        ],
        // The subtotals the Anexo 2 lists, every one, aligned to the right.
        right: [
          {
            kind: 'table',
            dense: true,
            columns: [
              { header: 'Subtotales', width: 0.68 },
              { header: 'Valor', width: 0.32, align: 'right' },
            ],
            rows: [
              [`SUBTOTAL ${sums.rateLabel}%`, sums.taxed],
              ['SUBTOTAL 0%', sums.zero],
              ['SUBTOTAL NO OBJETO DE IVA', sums.notSubject],
              ['SUBTOTAL EXENTO DE IVA', sums.exempt],
              ['SUBTOTAL SIN IMPUESTOS', sums.withoutTaxes],
              ['TOTAL DESCUENTO', data.discountTotal],
              ['ICE', '0.00'],
              [`IVA ${sums.rateLabel}%`, data.taxTotal],
              ['PROPINA', '0.00'],
              ['VALOR TOTAL', data.total],
            ],
          },
        ],
      },
    ],
    tearOff: null,
  };
}

/** BI-170. SRI table 24, as the RIDE names each way of paying. */
const PAYMENT_METHOD_LABEL: Readonly<Record<string, string>> = {
  '01': 'Sin utilización del sistema financiero',
  '15': 'Compensación de deudas',
  '16': 'Tarjeta de débito',
  '17': 'Dinero electrónico',
  '18': 'Tarjeta prepago',
  '19': 'Tarjeta de crédito',
  '20': 'Otros con utilización del sistema financiero',
  '21': 'Endoso de títulos',
};

/** SRI table 17: the codes that are not a rate. */
const NOT_SUBJECT_CODE = '6';
const EXEMPT_CODE = '7';
const ZERO_CODE = '0';
/** The general rate, printed when the invoice has nothing taxed. */
const GENERAL_RATE = '15';

/**
 * DOC-076. The Anexo 2 subtotals, from the frozen lines (each line's net and
 * its table 17 code), in cents so nothing rounds through a float.
 */
function invoiceSubtotals(data: InvoicePrintData): {
  rateLabel: string;
  taxed: string;
  zero: string;
  notSubject: string;
  exempt: string;
  withoutTaxes: string;
} {
  const cents = (amount: string): number => Math.round(Number(amount) * 100);
  const money = (value: number): string => (value / 100).toFixed(2);
  let taxed = 0;
  let zero = 0;
  let notSubject = 0;
  let exempt = 0;
  const rates = new Set<string>();
  for (const line of data.lines) {
    const net = cents(line.total);
    if (line.taxSriCode === NOT_SUBJECT_CODE) notSubject += net;
    else if (line.taxSriCode === EXEMPT_CODE) exempt += net;
    else if (line.taxSriCode === ZERO_CODE) zero += net;
    else {
      taxed += net;
      if (line.taxPercentage !== null) {
        rates.add(String(Number(line.taxPercentage)));
      }
    }
  }
  return {
    // One taxed rate is the norm; a mix is named as such rather than as 15.
    rateLabel: rates.size === 0 ? GENERAL_RATE : [...rates].join('/'),
    taxed: money(taxed),
    zero: money(zero),
    notSubject: money(notSubject),
    exempt: money(exempt),
    withoutTaxes: money(taxed + zero + notSubject + exempt),
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
