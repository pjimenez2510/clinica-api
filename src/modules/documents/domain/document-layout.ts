import {
  NA,
  type NotApplicable,
} from '../../../shared/domain/form-117/form-117';
import type { DateInNumbersAndWords } from '../../../shared/domain/form-117/date-in-words';
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
  DocumentLayout,
  LabelledValue,
  SectionRow,
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

/** D-095. When a document was issued or requested: date · hh:mm in Ecuador. */
function ecuadorianDateAndMinute(instant: Date): string {
  const time = wallClockOf(instant);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${ecuadorianDate(instant)} · ${two(time.hour)}:${two(time.minute)}`;
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
 * «—» when nobody recorded it — on the template's grid of four, followed by
 * what each document adds about the patient, two columns each.
 */
function patientBlock(
  patient: PatientIdentity,
  more: readonly LabelledValue[] = [],
): Block {
  const entries: LabelledValue[] = [
    {
      label: 'Apellidos y nombres',
      value: patient.fullName,
      span: patient.identifier === null ? 3 : 2,
    },
  ];
  if (patient.identifier !== null) {
    entries.push({ label: 'Documento', value: patient.identifier });
  }
  const age = ageText(patient.ageYears, patient.ageMonths);
  // DOC-060's sibling rule: an absent datum prints as an empty field, never as
  // an invented one. «—» says «nobody recorded this»; «0 años» would assert it.
  entries.push({ label: 'Edad', value: age ?? '—' });
  entries.push(...more.map((entry) => ({ ...entry, span: 2 })));
  return { kind: 'fields', columns: 4, entries };
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

  /**
   * Art. 70 of the Res. ACESS-2023-0030: a cancelled receta is not dispensed.
   * Printed — or reprinted — after the cancellation, it must not read as one a
   * pharmacy can fill: the legend heads the body and crosses every page.
   */
  const cancelled = data.status === 'CANCELLED';

  const blocks: Block[] = [
    ...(cancelled
      ? ([
          {
            kind: 'paragraph',
            text: 'RECETA ANULADA: no tiene validez y no se dispensa.',
            emphasis: true,
          },
        ] as Block[])
      : []),
    // ── Art. 5.a — datos generales, on the template's grey band (DOC-104).
    {
      kind: 'strip',
      entries: [
        { label: 'Ciudad', value: data.city ?? '—' },
        {
          label: 'Fecha de emisión',
          value: issuedAt === null ? '—' : ecuadorianDateAndMinute(issuedAt),
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
        // D-078. The chart number on every printed document.
        { label: 'Historia clínica', value: data.patient.mrn },
      ],
    },

    // ── Art. 5.b — datos del paciente.
    { kind: 'heading', text: 'Paciente' },
    patientBlock(data.patient, [
      {
        // Art. 5.b.iii.
        label: 'Diagnóstico',
        value:
          data.diagnoses.length === 0
            ? '—'
            : data.diagnoses.map((d) => `${d.code} · ${d.display}`).join(' | '),
      },
      {
        // Art. 5.b.iv. «Ninguna conocida» and not an empty box: a blank says
        // nobody asked, and this field exists precisely to record that
        // somebody did. DOC-085: a recorded allergy is printed in red.
        label: 'Antecedentes de alergias',
        value:
          data.allergies.length === 0
            ? 'Ninguna conocida'
            : data.allergies.join(', '),
        ...(data.allergies.length === 0 ? {} : { alert: true }),
      },
    ]),

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
   * PR-020. The number beside the title —it is what the ACESS reads to detect
   * a gap—; the pharmacy's check code goes to the frame's footer, with its QR.
   * A draft previewed before the issue has neither, and says so instead of
   * «null».
   */
  const reference =
    data.sequenceNumber === null || data.verificationCode === null
      ? 'Borrador — sin número'
      : `Receta N.º ${data.sequenceNumber}`;

  /**
   * PR-038, PR-039. Art. 5.e — what the PATIENT takes home, so it travels in
   * the detachable band. Demanded at the issue, so on an issued receta these
   * are never empty; a draft preview prints the gap with a dash.
   */
  const phone = data.prescriber.contactPhone;
  const patientIndications: Block = {
    // Side by side, in one row: one per row pushed an ordinary one-line receta
    // onto a second sheet.
    kind: 'fields',
    columns: 2,
    entries: [
      {
        label: 'Signos de alarma',
        // PR-040. IN the warning signs, because it is who to call when one
        // appears.
        value:
          phone === null
            ? (data.warningSigns ?? '—')
            : `${data.warningSigns ?? '—'}\nSi aparece alguno, llame al ${phone}.`,
      },
      {
        label: 'Recomendaciones no farmacológicas',
        value: data.nonPharmacologicalAdvice ?? '—',
      },
    ],
  };

  return {
    frame: {
      ...composeFrame(context, template, {
        kind: 'PRESCRIPTION',
        reference,
        confidential: data.diagnoses.length > 0,
        verificationCode: data.verificationCode,
      }),
      watermark: cancelled ? 'RECETA ANULADA' : null,
    },
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
              // Two columns, as the template: one per row pushed a receta of
              // three lines past the band.
              kind: 'fields',
              columns: 2,
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
  /**
   * ORD-007. A cancelled exam is not on the paper the laboratory receives —
   * as it is not on the screen—: printed, it is a puncture and a charge for
   * something nobody asked for any more. With every exam cancelled the order
   * is annulled (DOC-094 says so too), and the paper says it.
   */
  const live = data.items.filter((item) => item.status !== 'CANCELLED');
  const annulled = live.length === 0;

  // What the patient has to do before the extraction, once per distinct
  // instruction: an unstated fast is a second puncture (ORD-010).
  const preparations = [
    ...new Set(
      live
        .map((item) => item.preparation)
        .filter((text): text is string => text !== null && text.trim() !== ''),
    ),
  ];

  const blocks: Block[] = [
    ...(annulled
      ? ([
          {
            kind: 'paragraph',
            text: 'ORDEN ANULADA: todos sus exámenes están cancelados. No tiene validez.',
            emphasis: true,
          },
        ] as Block[])
      : []),
    // DOC-104. The general data on the template's grey band.
    {
      kind: 'strip',
      entries: [
        {
          label: 'Fecha de solicitud',
          value: ecuadorianDateAndMinute(data.requestedAt),
        },
        {
          label: 'Tipo',
          value: ORDER_CATEGORY_LABEL[data.category] ?? data.category,
        },
        {
          label: 'Prioridad',
          value: ORDER_PRIORITY_LABEL[data.priority] ?? data.priority,
        },
        // D-078. The chart number on every printed document.
        { label: 'Historia clínica', value: data.patient.mrn },
      ],
    },
    { kind: 'heading', text: 'Paciente' },
    patientBlock(data.patient, [
      {
        label: 'Diagnóstico presuntivo',
        value:
          data.diagnoses.length === 0
            ? '—'
            : data.diagnoses.map((d) => `${d.code} · ${d.display}`).join(' | '),
      },
      ...(data.clinicalNoteText === null
        ? []
        : [
            {
              label: 'Datos clínicos para el laboratorio',
              value: data.clinicalNoteText,
            },
          ]),
    ]),
    { kind: 'heading', text: 'Exámenes solicitados' },
    {
      kind: 'table',
      columns: [
        { header: 'Código', width: 0.28 },
        { header: 'Examen', width: 0.44 },
        { header: 'Muestra', width: 0.28 },
      ],
      rows: live.map((item) => [item.code, item.display, item.specimen ?? '—']),
    },
    // The template's framed note: what the patient has to do before going.
    {
      kind: 'box',
      light: true,
      blocks: [
        { kind: 'caption', text: 'Indicaciones al paciente' },
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
      ],
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
    // ORD-006 and D-095: the number on top, and in the footer the code a
    // laboratory checks the order with.
    frame: {
      ...composeFrame(context, template, {
        kind: 'SERVICE_ORDER',
        reference: `Orden N.º ${data.number}`,
        confidential: data.diagnoses.length > 0,
        verificationCode: data.verificationCode,
      }),
      watermark: annulled ? 'ORDEN ANULADA' : null,
    },
    blocks,
    tearOff: null,
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
 * 5216-A art. 33). The common frame prints it, beside the title.
 */
export function composeCertificateLayout(
  data: CertificatePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const form = data.form;
  const blocks: Block[] = [];

  if (form.revocation !== null) {
    // A revoked certificate that printed like a valid one is the failure this
    // line exists for: somebody is holding the paper.
    //
    // ⚠️ THE DATE AND NOTHING ELSE (CER-042, D-105 §5). The reason stays in the
    // row and on the screen: on an attendance certificate without diagnosis,
    // «era F32, no J06» tells the employer holding the paper what the patient
    // chose not to.
    blocks.push({
      kind: 'paragraph',
      text: `ANULADO el ${form.revocation.revokedOn.split('-').reverse().join('/')}. No tiene validez.`,
      emphasis: true,
    });
  }

  /** One row of cells of a block: label, value and its share of the row. */
  const cells = (
    ...entries: (LabelledValue & { width?: number; strong?: boolean })[]
  ): SectionRow => ({
    kind: 'cells',
    cells: entries.map((entry) => ({ ...entry, width: entry.width ?? 1 })),
  });

  // DOC-105. Each block of the 117 in its framed box, with its title bar; the
  // titles are the form's (DOC-075), which the template abbreviates.
  // ── A. Datos del establecimiento y usuario / paciente.
  blocks.push({
    kind: 'section',
    title: 'A. Datos del establecimiento y usuario / paciente',
    rows: [
      cells(
        { label: 'Institución del sistema', value: form.establishment.institution, width: 1.1 }, // prettier-ignore
        { label: 'Unicódigo', value: form.establishment.mspUnicode, width: 0.8 }, // prettier-ignore
        { label: 'Establecimiento de salud', value: form.establishment.name, width: 1.4 }, // prettier-ignore
        { label: 'Número de historia clínica única', value: form.establishment.clinicalRecordNumber, width: 1.1 }, // prettier-ignore
        { label: 'Número de archivo', value: form.establishment.archiveNumber, width: 0.9 }, // prettier-ignore
      ),
    ],
  });

  // ── B. Certifico que.
  blocks.push({
    kind: 'section',
    title: 'B. Certifico que',
    rows: [
      cells(
        { label: 'Primer apellido', value: form.patient.firstFamilyName },
        { label: 'Segundo apellido', value: form.patient.secondFamilyName },
        { label: 'Primer nombre', value: form.patient.firstGivenName },
        { label: 'Segundo nombre', value: form.patient.secondGivenName },
      ),
      cells(
        { label: 'Sexo', value: form.patient.sex },
        { label: 'Edad', value: `${form.patient.age.value} (${form.patient.age.condition})` }, // prettier-ignore
        { label: 'Fue atendido en el servicio de', value: form.attention.service }, // prettier-ignore
        { label: 'Especialidad', value: form.attention.specialty },
      ),
      cells(
        { label: 'Fecha de atención', value: form117Date(form.attention.date), width: 2 }, // prettier-ignore
        { label: 'Hora de atención', value: `desde ${form.attention.from} hasta ${form.attention.to}` }, // prettier-ignore
        { label: 'Fecha de ingreso', value: form.attention.admissionDate, width: 0.5 }, // prettier-ignore
        { label: 'Fecha de alta', value: form.attention.dischargeDate, width: 0.5 }, // prettier-ignore
      ),
      // CER-038. The IESS asks for where the patient works on a rest
      // certificate; the 117 has no box for it, so it closes block B, and only
      // on a rest. On attendance an employer reads the paper and has no
      // business here.
      ...(form.work === NA
        ? []
        : [
            cells(
              { label: 'Domicilio', value: form.work.address },
              { label: 'Teléfono', value: form.work.phone },
            ),
            cells(
              { label: 'Empresa', value: form.work.employer },
              { label: 'Puesto de trabajo', value: form.work.jobTitle },
            ),
          ]),
    ],
  });

  // ── C. Se recomienda. The type and the contingency go with the rest, as
  // the template's block C carries them.
  blocks.push({
    kind: 'section',
    title: 'C. Se recomienda',
    rows: [
      cells(
        { label: 'Tipo', value: CERTIFICATE_TYPE_LABEL[form.type] ?? NA },
        { label: 'Reposo', value: form.rest.rest, strong: true, width: 0.6 },
        {
          label: 'Días de reposo',
          value:
            form.rest.days === NA
              ? NA
              : `${form.rest.days} (${form.rest.daysInWords})`,
          strong: true,
        },
        { label: 'Contingencia', value: form.contingency },
      ),
      cells(
        { label: 'Desde', value: form117Date(form.rest.from) },
        { label: 'Hasta', value: form117Date(form.rest.to) },
      ),
      ...(form.rest.periodInWords === NA
        ? []
        : [{ kind: 'text' as const, text: form.rest.periodInWords }]),
      ...(form.maternity === NA
        ? []
        : [
            cells(
              { label: 'Fecha de ingreso', value: form117Date(form.maternity.admission) }, // prettier-ignore
              { label: 'Fecha del parto', value: form117Date(form.maternity.birth) }, // prettier-ignore
              { label: 'Fecha de alta', value: form117Date(form.maternity.discharge) }, // prettier-ignore
            ),
          ]),
    ],
  });

  // ── D. Diagnóstico, con su código CIE, o «NA».
  blocks.push({
    kind: 'section',
    title: 'D. Diagnóstico',
    rows: [
      form.diagnoses === NA
        ? { kind: 'text', text: NA }
        : {
            kind: 'table',
            columns: [
              { header: '#', width: 0.05 },
              { header: 'Diagnóstico', width: 0.8 },
              { header: 'CIE', width: 0.15 },
            ],
            rows: form.diagnoses.map((d, index) => [
              String(index + 1),
              d.display,
              d.code,
            ]),
          },
    ],
  });

  // ── E. Datos del profesional responsable, with the box for the seal inside
  // it (DOC-105): the seal vouches for what is written beside it, and a box
  // that cannot leave the block cannot end up alone on a page (DOC-101).
  blocks.push({
    kind: 'section',
    title: 'E. Datos del profesional responsable',
    rows: [
      cells(
        { label: 'Fecha', value: form.professional.date },
        { label: 'Hora', value: form.professional.time },
      ),
      cells(
        {
          label: 'Nombres y apellidos',
          value: `${form.professional.givenNames} ${form.professional.familyNames}`,
        },
        {
          label: 'Número de documento de identificación',
          value: form.professional.identification,
        },
      ),
      cells({ label: 'Lugar de emisión', value: form.placeOfIssue }),
    ],
    // CER-028. The credential signed it; the box is for the seal, never a
    // drawn stroke.
    signature: {
      caption: 'Firma (credencial del profesional en el sistema) y sello',
      image: data.issuedBy.seal !== null ? 'seal' : null,
    },
  });

  // DOC-075, CER-013 (D-095). How the rest is validated, on the paper the
  // patient carries to the IESS. Sources in D-075: the IESS's procedure (up to
  // eight days after the rest ends), its 2024 guide (a hand signature goes to
  // the counter; online needs a digital signature, which a credential is not)
  // and its 2025 digital validation (who it does not apply to). Only on a
  // rest: an attendance certificate is not validated.
  if (form.type === 'MEDICAL_REST') {
    blocks.push({
      kind: 'note',
      lines: [
        {
          label: 'Validación en el IESS: ',
          text: 'hasta 8 días después del fin del reposo. Este certificado lleva firma por credencial: se valida en ventanilla, impreso y firmado a mano. La validación en línea exige firma electrónica del profesional.',
        },
        {
          // A.M. 5216-A only where there is something it covers: a health
          // datum, which is exactly when the diagnosis is printed.
          text: form.confidential
            ? 'No aplica a afiliados voluntarios, menores de edad, jubilados ni afiliados al Seguro Social Campesino. Contiene datos de salud: su uso lo autoriza el paciente (A.M. 5216-A).'
            : 'No aplica a afiliados voluntarios, menores de edad, jubilados ni afiliados al Seguro Social Campesino.',
        },
      ],
    });
  }

  return {
    frame: {
      ...composeFrame(context, template, {
        kind: 'MEDICAL_CERTIFICATE',
        reference: `Certificado N.º ${form.number}`,
        // CER-033, DOC-082. Exactly when the diagnosis is printed.
        confidential: form.confidential,
        verificationCode: form.verificationCode,
      }),
      // CER-029. Across every page, not only the line at the top.
      watermark: form.revocation === null ? null : 'CERTIFICADO ANULADO',
    },
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

  // DOC-076, DOC-106. The issuer's box of the approved page «Factura»
  // (D-095): legal name, trade name, head office and establishment
  // addresses, and the fiscal legends that apply. The logo, when there is
  // one, sits above it in the same column.
  const issuerBox: Block[] = [
    { kind: 'name', text: establishment.name },
    ...(establishment.tradeName === null ||
    establishment.tradeName === establishment.name
      ? []
      : ([{ kind: 'paragraph', text: establishment.tradeName }] as Block[])),
    {
      kind: 'fields',
      columns: 1,
      inline: true,
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
      inline: true,
      entries: [{ label: 'R.U.C.', value: establishment.ruc ?? '—' }],
    },
    // DOC-106. The voucher's own name, large and in the accent.
    { kind: 'title', text: 'FACTURA' },
    {
      kind: 'fields',
      columns: 1,
      inline: true,
      entries: [{ label: 'No.', value: data.documentNumber }],
    },
    {
      kind: 'fields',
      columns: 1,
      entries: [
        // The access key IS the authorisation number for the offline scheme.
        // SRI-071: until the SRI authorises, the RIDE is handed over saying
        // so — never a number or a date that does not exist yet.
        {
          label: 'NÚMERO DE AUTORIZACIÓN',
          value:
            data.authorisedAt === null ? unauthorised : (data.accessKey ?? '—'),
        },
      ],
    },
    {
      kind: 'fields',
      columns: 1,
      inline: true,
      entries: [
        {
          label: 'FECHA Y HORA DE AUTORIZACIÓN',
          value:
            data.authorisedAt === null
              ? unauthorised
              : ecuadorianDateTime(data.authorisedAt),
        },
      ],
    },
    // SRI-070. The environment is the one written INSIDE the key (its 24th
    // digit), never a constant: a test voucher printed «PRODUCCIÓN» claims a
    // validity it does not have. Ambiente and emisión share a row, as on the
    // approved page.
    {
      kind: 'fields',
      columns: 2,
      inline: true,
      entries: [
        { label: 'AMBIENTE', value: environmentOf(data.accessKey) },
        { label: 'EMISIÓN', value: 'NORMAL' },
      ],
    },
    // D-095 §5, DOC-078, DOC-106. The key ONCE, centred under its Code 128
    // bars — only when there is a key to encode; «—» when there is none yet.
    ...(data.accessKey === null
      ? ([
          {
            kind: 'fields',
            columns: 1,
            entries: [{ label: 'CLAVE DE ACCESO', value: '—' }],
          },
        ] as Block[])
      : ([
          { kind: 'caption', text: 'CLAVE DE ACCESO' },
          { kind: 'barcode', value: data.accessKey },
        ] as Block[])),
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
      // DOC-106. The two boxes finish level: the issuer's is stretched.
      {
        kind: 'boxes',
        left: [
          { kind: 'logo' },
          { kind: 'box', rounded: true, blocks: issuerBox },
        ],
        right: [{ kind: 'box', rounded: true, blocks: voucherBox }],
      },
      {
        kind: 'box',
        rounded: true,
        blocks: [
          {
            kind: 'fields',
            columns: 2,
            inline: true,
            entries: [
              {
                label: 'Razón social / Apellidos y nombres',
                value: data.buyerName,
              },
              { label: 'Identificación', value: data.buyerIdentification },
              {
                label: 'Fecha de emisión',
                value:
                  data.issuedAt === null ? '—' : ecuadorianDate(data.issuedAt),
              },
              ...(data.buyerAddress === null
                ? []
                : [{ label: 'Dirección', value: data.buyerAddress, span: 2 }]),
            ],
          },
        ],
      },
      {
        kind: 'table',
        framed: 'grid',
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
        // The template's 1.15fr · 1fr.
        leftShare: 0.535,
        left: [
          ...(additional.length === 0
            ? []
            : ([
                {
                  kind: 'box',
                  title: 'Información adicional',
                  blocks: [
                    {
                      kind: 'fields',
                      columns: 1,
                      inline: true,
                      entries: additional,
                    },
                  ],
                },
              ] as Block[])),
          // BI-170. The way it was paid, with its SRI table 24 code.
          {
            kind: 'table',
            framed: 'box',
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
        // The subtotals the Anexo 2 lists, every one, aligned to the right,
        // with no header of their own and the total in bold on grey.
        right: [
          {
            kind: 'table',
            dense: true,
            framed: 'box',
            headless: true,
            emphasiseLast: true,
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
