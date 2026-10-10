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

import { allergyHistoryOf } from '../../../shared/clinical/allergy-history';
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
  ClinicalFormPrintData,
  CreditNotePrintData,
  DocumentContext,
  DocumentSubject,
  ClinicalRecordCopyPrintData,
  EncounterSummaryPrintData,
  InvoiceLine,
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
/**
 * PR-036. The constancia of a signature made with the prescriber's credential,
 * the same sentence the receta screen paints: signed in the system, when, and
 * WITHOUT an electronic signature certificate.
 */
export function credentialSignatureText(signedAt: Date): string {
  return `Con usuario y clave en el sistema, el ${ecuadorianDate(signedAt)}, sin certificado de firma electrónica`;
}

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
        // Art. 5.b.iv, DOC-116. Never an empty box, and never «Ninguna
        // conocida»: an empty list is «not known», not «none» (EN-087,
        // D-A-018), and the pharmacy reading this line has no chart to ask.
        // The sentence is the receta screen's, from the same function (PR-117):
        // the allergies, the standing assertion with who and when, or «No
        // registradas: pregunte al paciente». DOC-085: only an allergy is red.
        label: 'Antecedentes de alergias',
        value: allergyHistoryOf(data.allergies, data.noKnownAllergies),
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
          line.durationDays === null
            ? null
            : `por ${line.durationDays} ${line.durationDays === 1 ? 'día' : 'días'}`,
        ]
          .filter(Boolean)
          .join(' · '),
      ]),
    },
  ];

  // PR-110, REQ-054. The MARK is what is due; the reason only if one was given.
  const offFormulary = data.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.offFormulary);

  if (offFormulary.length > 0) {
    blocks.push({
      kind: 'fields',
      columns: 1,
      entries: offFormulary.map(({ line, index }) => ({
        label: `Fuera del CNMB — línea ${index + 1}`,
        value:
          line.offFormularyJustification ??
          'Medicamento o presentación que no consta en el cuadro',
      })),
    });
  }

  // ── Art. 5.d — datos del prescriptor, con su sello (d.iii).
  blocks.push(
    { kind: 'heading', text: 'Prescriptor' },
    prescriberBlock(data.prescriber),
    {
      // PR-036 (D-A-005, D-183.2). How it was signed, said explicitly: the
      // pharmacy rule accepts «la signatura realizada en el sistema informático
      // mediante el registro con usuario y clave de acceso», and nothing in
      // this system holds a certificate yet. A receta that said nothing would
      // read as certified to whoever assumes so.
      kind: 'fields',
      columns: 1,
      entries: [
        {
          label: 'Firma',
          value: issuedAt === null ? '—' : credentialSignatureText(issuedAt),
        },
      ],
    },
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
          // Art. 5.e.iv and v: once torn off, the band is all the patient
          // keeps, so it carries the prescriber's signature and seal AND the
          // ACESS registration. Under the box and not in the identification
          // row: a third column wrapped the name and pushed the band past its
          // fixed height (DOC-073).
          kind: 'signature',
          caption: `Firma y sello del profesional\nRegistro ACESS ${data.prescriber.acessRegistration ?? '—'}`,
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
      // ORD-126. Form 010A's header carries it.
      { label: 'Sexo', value: SEX_LABEL[data.patientSex] ?? '—' },
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
    ...examsBySection(live),
    // The template's framed note: what the patient has to do before going.
    { kind: 'box', light: true, blocks: instructionsFor(live) },
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

/** ORD-126. How the 010A header says the sex; «—» for what nobody declared. */
const SEX_LABEL: Readonly<Record<string, string>> = {
  MALE: 'Hombre',
  FEMALE: 'Mujer',
  INTERSEX: 'Intersexual',
};

type OrderItem = ServiceOrderPrintData['items'][number];

/**
 * ORD-126, D-136 A. The live exams under their section of form 010A, each
 * section in the order it first appears in the order, and those without one
 * last, under «OTROS EXÁMENES»: it reads as the 010A and still fits each
 * clinic's own catalogue.
 */
function examsBySection(live: readonly OrderItem[]): Block[] {
  const OTHERS = 'OTROS EXÁMENES';
  const groups = new Map<string, OrderItem[]>();
  for (const item of live) {
    const section = item.section?.trim() || OTHERS;
    groups.set(section, [...(groups.get(section) ?? []), item]);
  }
  const ordered = [
    ...[...groups.keys()].filter((section) => section !== OTHERS),
    ...(groups.has(OTHERS) ? [OTHERS] : []),
  ];
  return ordered.flatMap((section): Block[] => [
    { kind: 'caption', text: section },
    {
      kind: 'table',
      columns: [
        { header: 'Código', width: 0.28 },
        { header: 'Examen', width: 0.44 },
        { header: 'Muestra', width: 0.28 },
      ],
      rows: (groups.get(section) ?? []).map((item) => [
        item.code,
        item.display,
        item.specimen ?? '—',
      ]),
    },
  ]);
}

/**
 * ORD-125, ORD-129. What the patient has to do before going, each with the
 * name of its exam; an exam with nothing to do takes no line. A fast is said
 * ON TOP, once for the whole sampling, naming who asks for it: an unstated
 * fast is a second puncture (ORD-010).
 *
 * The fast comes from the exam's «Pide ayuno» (D-137), not from how its
 * preparation is worded; the hours are the LONGEST minimum among the exams
 * that ask, which satisfies them all.
 */
function instructionsFor(live: readonly OrderItem[]): Block[] {
  const asked = live
    .map((item) => ({
      exam: item.display,
      text: item.preparation?.trim() ?? '',
    })) // prettier-ignore
    .filter(({ text }) => text !== '' && !nothingToDo(text));
  const fasting = fastingLine(live);

  const caption: Block = { kind: 'caption', text: 'Indicaciones al paciente' };
  if (asked.length === 0 && fasting === null) {
    return [caption, { kind: 'paragraph', text: 'No requiere preparación previa.' }]; // prettier-ignore
  }
  return [
    caption,
    ...(fasting === null
      ? []
      : ([{ kind: 'paragraph', text: fasting, emphasis: true }] as Block[])),
    ...(asked.length === 0
      ? []
      : ([
          {
            kind: 'fields',
            columns: 1,
            entries: asked.map(({ exam, text }) => ({ label: exam, value: text })), // prettier-ignore
          },
        ] as Block[])),
  ];
}

/**
 * ORD-129. «Venga con 8 horas de ayuno como mínimo (Glucosa en ayunas).», or
 * «Venga en ayunas (…).» when no exam says how long; `null` without a fast.
 */
function fastingLine(
  live: readonly Pick<OrderItem, 'display' | 'fasting'>[],
): string | null {
  const fasts = live.filter((item) => item.fasting !== null);
  if (fasts.length === 0) return null;
  const names = fasts.map((item) => item.display).join(', ');
  const hours = fasts
    .map((item) => item.fasting?.hours ?? null)
    .filter((value): value is number => value !== null);
  if (hours.length === 0) return `Venga en ayunas (${names}).`;
  const most = Math.max(...hours);
  return `Venga con ${most} ${most === 1 ? 'hora' : 'horas'} de ayuno como mínimo (${names}).`;
}

/**
 * ORD-125. «No requiere ayuno.» says there is nothing to do; «No requiere
 * ayuno. Recoja la primera orina de la mañana.» does not, and is printed whole.
 * Only a text that is ONE sentence beginning with «No requiere» is left out.
 */
function nothingToDo(text: string): boolean {
  return /^no requiere[^.]*\.?$/i.test(text.trim());
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
            // CER-027. The X in PRE or in DEF, by the certainty the issue
            // copied; neither when the copy has none.
            columns: [
              { header: '#', width: 0.05 },
              { header: 'Diagnóstico', width: 0.67 },
              { header: 'CIE', width: 0.12 },
              { header: 'PRE', width: 0.08, align: 'centre' },
              { header: 'DEF', width: 0.08, align: 'centre' },
            ],
            rows: form.diagnoses.map((d, index) => [
              String(index + 1),
              d.display,
              d.code,
              d.certainty === 'PRESUMPTIVE' ? 'X' : '',
              d.certainty === 'DEFINITIVE' ? 'X' : '',
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
  // eight days after the rest ends) and its 2024 guide (a hand signature goes
  // to the counter; online needs a digital signature, which a credential is
  // not). Who the 2025 online validation excludes is not printed (D-114): the
  // exclusion is of a path this paper does not admit, and read under
  // «Validación en el IESS» it told a minor the counter was closed to them.
  // Only on a rest: an attendance certificate is not validated. And never on
  // a revoked one: instructions to validate a void certificate are the
  // opposite of what its «ANULADO» says (CER-029).
  if (form.type === 'MEDICAL_REST' && form.revocation === null) {
    blocks.push({
      kind: 'note',
      lines: [
        {
          label: 'Validación en el IESS: ',
          text: 'hasta 8 días después del fin del reposo. Este certificado lleva firma por credencial: se valida en ventanilla, impreso y firmado a mano. La validación en línea exige firma electrónica del profesional.',
        },
        // A.M. 5216-A only where there is something it covers: a health
        // datum, which is exactly when the diagnosis is printed.
        ...(form.confidential
          ? [
              {
                // D-121: the legend protects the patient; the agreement's
                // number only recited the norm.
                text: 'Contiene datos de salud: su uso lo autoriza el paciente.',
              },
            ]
          : []),
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
 * DOC-076, DOC-106. The issuer's box of the approved page «Factura» (D-095):
 * legal name, trade name, head office and establishment addresses, and the
 * fiscal legends that apply. The logo, when there is one, sits above it in
 * the same column. SRI-089: the credit note's RIDE prints the same box.
 */
function rideIssuerBox(context: DocumentContext): Block[] {
  const { establishment } = context;
  return [
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
}

/** What the voucher's box needs to know about the voucher it describes. */
interface RideVoucher {
  documentNumber: string;
  accessKey: string | null;
  status: string;
  authorisedAt: Date | null;
}

/**
 * DOC-076, DOC-106, SRI-070, SRI-071. The voucher's box: RUC, the voucher's
 * own name as a title (`FACTURA`, `NOTA DE CRÉDITO`), its number, the
 * authorisation or what stands in for it, the environment and the key.
 */
function rideVoucherBox(
  title: string,
  data: RideVoucher,
  context: DocumentContext,
): Block[] {
  // SRI-071. Pending only while it can still be authorised: a returned or
  // refused voucher must not promise an authorisation that will not come.
  const unauthorised =
    data.status === 'REJECTED' ? NOT_AUTHORISED : PENDING_AUTHORISATION;
  return [
    {
      kind: 'fields',
      columns: 1,
      inline: true,
      entries: [{ label: 'R.U.C.', value: context.establishment.ruc ?? '—' }],
    },
    // DOC-106. The voucher's own name, large and in the accent.
    { kind: 'title', text: title },
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
}

/** DOC-106. The two boxes that head a RIDE; they finish level. */
function rideHead(
  context: DocumentContext,
  issuerBox: Block[],
  voucherBox: Block[],
): Block {
  return {
    kind: 'boxes',
    left: [
      // DOC-059. Only with a logo: the decision is the composer's.
      ...(context.establishment.logo === null
        ? []
        : [{ kind: 'logo' } as const]),
      { kind: 'box', rounded: true, blocks: issuerBox },
    ],
    right: [{ kind: 'box', rounded: true, blocks: voucherBox }],
  };
}

/** DOC-076. The detail table of a RIDE, one row per frozen line. */
function rideDetailTable(lines: readonly InvoiceLine[]): Block {
  return {
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
    rows: lines.map((line) => [
      line.code,
      line.auxiliaryCode ?? '—',
      line.quantity,
      line.description,
      line.unitPrice,
      line.discount,
      line.total,
    ]),
  };
}

/**
 * The subtotals the Anexo 2 lists, every one, aligned to the right, with no
 * header of their own and the total in bold on grey. `tip` is the invoice's
 * «PROPINA» line, which the credit note's RIDE does not carry (SRI-089).
 */
function rideTotalsTable(
  data: {
    lines: readonly InvoiceLine[];
    discountTotal: string;
    taxTotal: string;
    total: string;
  },
  tip: boolean,
): Block {
  const sums = rideSubtotals(data.lines);
  return {
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
      ...(tip ? [['PROPINA', '0.00']] : []),
      ['VALOR TOTAL', data.total],
    ],
  };
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

  return {
    frame: composeFrame(context, template, {
      kind: 'INVOICE_RIDE',
      reference: data.documentNumber,
      confidential: false,
      verificationCode: null,
    }),
    blocks: [
      rideHead(
        context,
        rideIssuerBox(context),
        rideVoucherBox('FACTURA', data, context),
      ),
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
      rideDetailTable(data.lines),
      {
        kind: 'boxes',
        // The template's 1.15fr · 1fr.
        leftShare: 0.535,
        left: [
          ...additionalInformation(additional),
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
        right: [rideTotalsTable(data, true)],
      },
    ],
    tearOff: null,
  };
}

/** DOC-076 «Información adicional», boxed under its title bar; none if empty. */
function additionalInformation(entries: LabelledValue[]): Block[] {
  return entries.length === 0
    ? []
    : [
        {
          kind: 'box',
          title: 'Información adicional',
          blocks: [{ kind: 'fields', columns: 1, inline: true, entries }],
        },
      ];
}

/**
 * SRI-089. The RIDE of a credit note: the invoice's page (Ficha Técnica,
 * Anexo 2) with «NOTA DE CRÉDITO» in the voucher's box, the invoice it
 * modifies with its date and the reason beside the receiver, its lines, and
 * the subtotals of the credit note — no «PROPINA» and no way of paying: a
 * credit note is not paid.
 */
export function composeCreditNoteLayout(
  data: CreditNotePrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  return {
    frame: composeFrame(context, template, {
      kind: 'CREDIT_NOTE_RIDE',
      reference: data.documentNumber,
      confidential: false,
      verificationCode: null,
    }),
    blocks: [
      rideHead(
        context,
        rideIssuerBox(context),
        rideVoucherBox('NOTA DE CRÉDITO', data, context),
      ),
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
              {
                label: 'Comprobante que se modifica',
                value: `FACTURA ${data.modifiedDocument.number}`,
              },
              {
                label: 'Fecha de emisión (comprobante a modificar)',
                value:
                  data.modifiedDocument.issuedAt === null
                    ? '—'
                    : ecuadorianDate(data.modifiedDocument.issuedAt),
              },
              { label: 'Razón de modificación', value: data.reason, span: 2 },
            ],
          },
        ],
      },
      rideDetailTable(data.lines),
      {
        kind: 'boxes',
        leftShare: 0.535,
        left: additionalInformation(
          data.buyerEmail === null
            ? []
            : [{ label: 'Correo', value: data.buyerEmail }],
        ),
        right: [rideTotalsTable(data, false)],
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
function rideSubtotals(lines: readonly InvoiceLine[]): {
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
  for (const line of lines) {
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

/** DOC-111. How a diagnosis's condition prints (block J of form 002). */
const CERTAINTY_LABEL: Readonly<Record<string, string>> = {
  PRESUMPTIVE: 'Presuntivo',
  DEFINITIVE: 'Definitivo',
};

/**
 * DOC-111, DOC-118. What one attention prints: on its own summary, with the
 * patient; inside the copy of the clinical record, whose cover names the
 * person once, without.
 */
function encounterSummaryBlocks(
  data: EncounterSummaryPrintData,
  siteName: string,
  options: { withPatient: boolean },
): Block[] {
  const section = (title: string, blocks: readonly Block[]): Block[] =>
    blocks.length === 0 ? [] : [{ kind: 'heading', text: title }, ...blocks];

  const blocks: Block[] = [
    {
      kind: 'strip',
      entries: [
        { label: 'Fecha de la atención', value: ecuadorianDateAndMinute(data.startedAt) }, // prettier-ignore
        { label: 'Sede', value: siteName },
        // D-078. The chart number on every printed document; in the copy,
        // the age that day (the cover names the person once).
        options.withPatient
          ? { label: 'Historia clínica', value: data.patient.mrn }
          : { label: 'Edad', value: ageText(data.patient.ageYears, data.patient.ageMonths) ?? '—' }, // prettier-ignore
      ],
    },
    ...(options.withPatient
      ? ([
          { kind: 'heading', text: 'Paciente' },
          patientBlock(data.patient, [
            { label: 'Sexo', value: SEX_LABEL[data.patientSex] ?? '—' },
          ]),
        ] as Block[])
      : []),
    { kind: 'heading', text: 'Atendido por' },
    prescriberBlock(data.practitioner),
    ...section(
      'Signos vitales y antropometría',
      data.vitals.length === 0
        ? []
        : [{ kind: 'fields', columns: 4, entries: data.vitals }],
    ),
    ...section('Nota de consulta externa', [
      ...(data.note?.amendedAt == null
        ? []
        : ([
            {
              kind: 'paragraph',
              text: `Nota enmendada el ${ecuadorianDate(data.note.amendedAt)}. Esta es la versión vigente.`,
              emphasis: true,
            },
          ] as Block[])),
      // EN-156. The constancy travels with the paper, not only the screen.
      ...(data.note?.withoutCertificate === true
        ? ([
            {
              kind: 'paragraph',
              text: 'Firmada sin certificado electrónico, con la credencial del profesional.',
            },
          ] as Block[])
        : []),
      ...(data.note === null || data.note.sections.length === 0
        ? []
        : ([
            {
              kind: 'fields',
              columns: 1,
              entries: data.note.sections.map((s) => ({
                label: s.title,
                value: s.text,
              })),
            },
          ] as Block[])),
    ]),
    ...section(
      'Diagnósticos',
      data.diagnoses.length === 0
        ? []
        : [
            {
              kind: 'table',
              columns: [
                { header: 'CIE-10', width: 0.16 },
                { header: 'Diagnóstico', width: 0.62 },
                { header: 'Condición', width: 0.22 },
              ],
              rows: data.diagnoses.map((d) => [
                d.code,
                d.principal ? `${d.display} (principal)` : d.display,
                CERTAINTY_LABEL[d.certainty] ?? '—',
              ]),
            },
          ],
    ),
    ...section(
      'Receta',
      data.prescriptions
        .filter((p) => p.lines.length > 0)
        .map((p): Block => ({
          kind: 'fields',
          columns: 1,
          entries: p.lines.map((line, index) => ({
            label:
              index === 0 && p.sequenceNumber !== null
                ? `Receta N.º ${p.sequenceNumber}`
                : 'Medicamento',
            value: indicationsText(line),
          })),
        })),
    ),
    ...section(
      'Exámenes pedidos',
      data.exams.length === 0
        ? []
        : [
            {
              kind: 'table',
              columns: [
                { header: 'Orden', width: 0.2 },
                { header: 'Examen', width: 0.8 },
              ],
              rows: data.exams.map((exam) => [
                exam.orderNumber === null ? '—' : `N.º ${exam.orderNumber}`,
                exam.display,
              ]),
            },
          ],
    ),
    ...section(
      'Certificados',
      data.certificates.length === 0
        ? []
        : [
            {
              kind: 'fields',
              columns: 1,
              entries: data.certificates.map((c) => ({
                label: `Certificado N.º ${c.number}`,
                value: [
                  CERTIFICATE_TYPE_LABEL[c.type] ?? '—',
                  c.restFrom === null || c.restTo === null
                    ? null
                    : `del ${calendarDate(c.restFrom)} al ${calendarDate(c.restTo)}`,
                ]
                  .filter(Boolean)
                  .join(', '),
              })),
            },
          ],
    ),
    // DOC-115 (D-139.4). No signature nor seal: nobody signs a summary composed
    // when someone downloads it; «Atendido por» names the professional and
    // the attention's code proves it (DOC-112).
  ];

  return blocks;
}

/**
 * DOC-111. The summary of an attention: one PDF for the patient and for the
 * doctor who receives it. No MSP form fixes it (searched: ESPECIFICACION and
 * Annex 1 of A.M. 00115-2021); it follows the approved frame (D-095) and the
 * order of the blocks of form 002. A block with nothing in it is not printed.
 *
 * Composed on demand and never archived: what it says is the attention as it
 * stands, and its code verifies the ATTENTION (DOC-112), not this file.
 */
export function composeEncounterSummaryLayout(
  data: EncounterSummaryPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  return {
    frame: composeFrame(context, template, {
      kind: 'ENCOUNTER_SUMMARY',
      reference: `Atención del ${ecuadorianDate(data.startedAt)}`,
      // DOC-114 (D-139.3). Always: it carries the whole 002 note, health
      // information with or without a coded diagnosis.
      confidential: true,
      verificationCode: data.verificationCode,
    }),
    blocks: encounterSummaryBlocks(data, context.siteName, {
      withPatient: true,
    }),
    tearOff: null,
  };
}

/** PD-052. Who presented the request, as the copy's cover says it. */
const REQUESTER_LABEL: Readonly<Record<string, string>> = {
  HOLDER: 'El paciente',
  REPRESENTATIVE: 'Su representante legal',
  ATTORNEY: 'Su apoderado',
  AUTHORIZED_PERSON: 'Una persona autorizada por el paciente',
  AUTHORITY: 'Una autoridad judicial o de salud',
  DECEASED_RELATIVE: 'Un familiar del paciente fallecido',
};

/** DOC-118. The paper's title: the A.M. 5216 calls it a certified copy. */
export const CLINICAL_RECORD_COPY_TITLE =
  'COPIA CERTIFICADA DE LA HISTORIA CLÍNICA';

/**
 * DOC-118 (D-198 §1, A.M. 5216 arts. 28 to 33). The copy of the clinical
 * record handed to the holder or to a third party: a cover that says who asked
 * for it, who authorised it, that the establishment certifies it as custodian
 * and that whoever receives it answers for its confidentiality; then every
 * attention with a signed 002, oldest first, as its summary prints it (DOC-111)
 * with its own verification code.
 *
 * ⚠️ WITHOUT THE VIOLENCE SCREENING (D-188 §3), and the cover says so: block F
 * leaves no paper or file of the holder's without a professional's review. The
 * summary never carried it either.
 *
 * No QR of its own: it is not archived, and each attention's code verifies
 * that attention (DOC-112).
 */
export function composeClinicalRecordCopyLayout(
  data: ClinicalRecordCopyPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
  issuedAt: Date,
): DocumentLayout {
  const establishment =
    context.establishment.tradeName ?? context.establishment.name;
  const requester = REQUESTER_LABEL[data.requestedBy] ?? '—';

  const cover: Block[] = [
    {
      kind: 'strip',
      entries: [
        { label: 'Fecha de emisión', value: ecuadorianDateAndMinute(issuedAt) },
        // D-078. The chart number on every printed document.
        { label: 'Historia clínica', value: data.patient.mrn },
        { label: 'Atenciones', value: String(data.encounters.length) },
      ],
    },
    { kind: 'heading', text: 'Paciente' },
    {
      kind: 'fields',
      columns: 4,
      entries: [
        {
          label: 'Apellidos y nombres',
          value: data.patient.fullName,
          span: data.patient.identifier === null ? 3 : 2,
        },
        ...(data.patient.identifier === null
          ? []
          : [{ label: 'Documento', value: data.patient.identifier }]),
        { label: 'Sexo', value: SEX_LABEL[data.patientSex] ?? '—' },
      ],
    },
    { kind: 'heading', text: 'Entrega' },
    {
      kind: 'fields',
      columns: 2,
      entries: [
        {
          label: 'Solicitada por',
          value:
            data.requesterName === null
              ? requester
              : `${requester}: ${data.requesterName}`,
        },
        ...(data.requesterDocument === null
          ? []
          : [{ label: 'Cédula u oficio', value: data.requesterDocument }]),
        {
          label: 'Solicitud recibida',
          value: ecuadorianDateAndMinute(data.receivedAt),
        },
        { label: 'Autorizada por', value: data.authorisedBy },
        {
          label: 'Autorizada el',
          value: ecuadorianDateAndMinute(data.authorisedAt),
        },
      ],
    },
    {
      kind: 'paragraph',
      text: `${establishment}, custodio de la historia clínica, certifica que esta copia reproduce lo registrado en su sistema a la fecha de emisión.`,
    },
    {
      kind: 'note',
      lines: [
        {
          label: 'Confidencial: ',
          text: 'quien recibe esta copia responde de su custodia y de que no se difunda.',
        },
        {
          label: 'No incluye: ',
          text: 'el tamizaje de violencia, que sólo se entrega después de que lo revise un profesional.',
        },
      ],
    },
  ];

  const attentions: Block[] =
    data.encounters.length === 0
      ? [
          {
            kind: 'paragraph',
            text: 'La historia clínica no tiene atenciones con nota de consulta firmada.',
            emphasis: true,
          },
        ]
      : data.encounters.flatMap((encounter): Block[] => [
          { kind: 'rule' },
          {
            kind: 'title',
            text: `Atención del ${ecuadorianDate(encounter.startedAt)}`,
          },
          ...encounterSummaryBlocks(encounter, encounter.siteName, {
            withPatient: false,
          }),
          {
            kind: 'fields',
            columns: 1,
            entries: [
              {
                label: 'Código de verificación de la atención',
                value: encounter.verificationCode,
              },
            ],
          },
        ]);

  return {
    frame: composeFrame(context, template, {
      kind: 'ENCOUNTER_SUMMARY',
      title: CLINICAL_RECORD_COPY_TITLE,
      reference: `Historia clínica ${data.patient.mrn}`,
      // A.M. 5216 art. 33: «CONFIDENCIAL» in the top margin, always.
      confidential: true,
      verificationCode: null,
    }),
    blocks: [...cover, ...attentions],
    tearOff: null,
  };
}

/**
 * EN-243. Form 053 or 007, from its signed note: the patient, the sections as
 * the note froze them, the constancy of how it was signed, and the signature
 * and seal of whoever issued it. No QR: it is not archived (D-191 §4).
 */
export function composeClinicalFormLayout(
  data: ClinicalFormPrintData,
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentLayout {
  const blocks: Block[] = [
    {
      kind: 'strip',
      entries: [
        { label: 'Fecha de emisión', value: ecuadorianDateAndMinute(data.signedAt) }, // prettier-ignore
        { label: 'Sede', value: context.siteName },
        // D-078. The chart number on every printed document.
        { label: 'Historia clínica', value: data.patient.mrn },
      ],
    },
    ...(data.annulled
      ? ([
          {
            kind: 'paragraph',
            text: 'ANULADA: este documento ya no tiene validez.',
            emphasis: true,
          },
        ] as Block[])
      : []),
    { kind: 'heading', text: 'Paciente' },
    patientBlock(data.patient, [
      {
        label: 'Atención',
        value: ecuadorianDateAndMinute(data.encounterStartedAt),
      },
    ]),
    { kind: 'heading', text: data.title.charAt(0) + data.title.slice(1).toLowerCase() }, // prettier-ignore
    {
      kind: 'fields',
      columns: 1,
      entries: data.sections.map((each) => ({
        label: each.title,
        value: each.text,
      })),
    },
    { kind: 'heading', text: 'Profesional' },
    prescriberBlock(data.signer),
    // EN-156. The constancy travels with the paper, not only the screen.
    ...(data.withoutCertificate
      ? ([
          { kind: 'paragraph', text: credentialSignatureText(data.signedAt) },
        ] as Block[])
      : []),
    {
      kind: 'signature',
      caption: 'Firma y sello del profesional',
      image: data.signer.seal !== null ? 'seal' : null,
    },
  ];

  return {
    frame: composeFrame(context, template, {
      kind: 'CLINICAL_FORM',
      title: data.annulled ? `${data.title} (ANULADA)` : data.title,
      reference: `Formulario ${data.formCode}`,
      // It carries the reason and the diagnoses: health information.
      confidential: true,
      verificationCode: null,
    }),
    blocks,
    tearOff: null,
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
    case 'ENCOUNTER_SUMMARY':
      return composeEncounterSummaryLayout(subject.data, context, template);
    case 'CREDIT_NOTE_RIDE':
      return composeCreditNoteLayout(subject.data, context, template);
    case 'CLINICAL_FORM':
      return composeClinicalFormLayout(subject.data, context, template);
  }
}
