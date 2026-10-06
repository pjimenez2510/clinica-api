import {
  BusinessRuleViolation,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import type { EncounterStatus, NoteStatus } from './encounter';

/**
 * What can go wrong in an attention, in business terms.
 *
 * No HTTP here: the CATEGORY decides the status in `problem-details.filter.ts`
 * — which is what lets these same rules run from an import script or a worker,
 * where «409» means nothing.
 *
 * ⚠️ NOT ONE OF THESE MESSAGES NAMES THE PATIENT (EN-124, SC-016). No name, no
 * document, no reason for the visit, no CIE-10 code, no chart identifier.
 * These sentences reach logs and support screenshots, and here the datum that
 * would leak is a diagnosis rather than an hour.
 *
 * NOT DECLARED HERE, on purpose: `VITALS_OUT_OF_RANGE` and
 * `NOTE_ALREADY_CURRENT`. Those two are PostgreSQL constraints speaking
 * (`encounter_vitals_ranges_*`, `clinical_note_one_current_per_chain`) and they
 * travel through the database error mapping, which is its own enumeration.
 * Restating them in TypeScript would be a second, weaker copy of a rule the
 * database already guarantees.
 */

/**
 * The Spanish label of each state, as the SCREEN names them.
 *
 * Lives next to the errors that speak them because the requirement is about
 * the MESSAGE: EN-132 demands that the refusal say what state the attention is
 * in and what can be done from there, and «DISCHARGED» says that to a
 * programmer, not to a doctor.
 */
const STATUS_LABEL: Readonly<Record<EncounterStatus, string>> = {
  OPEN: 'En curso',
  ON_HOLD: 'Suspendida',
  DISCONTINUED: 'Interrumpida',
  DISCHARGED: 'Con alta clínica',
  COMPLETED: 'Cerrada',
  ENTERED_IN_ERROR: 'Anulada',
};

/** What can still be done from each state, in the words the screen uses. */
const WHAT_TO_DO: Readonly<Record<EncounterStatus, string>> = {
  OPEN: 'puede documentarse, suspenderse o interrumpirse',
  ON_HOLD: 'puede reanudarse o interrumpirse',
  DISCONTINUED: 'ya no admite ningún cambio',
  DISCHARGED: 'solo admite cerrar la cuenta o enmendar una nota',
  COMPLETED: 'ya no admite ningún cambio',
  ENTERED_IN_ERROR: 'ya no admite ningún cambio',
};

/**
 * EN-121. The attention does not exist — or belongs to a site outside the
 * caller's scope.
 *
 * ONE ANSWER FOR BOTH, and it is the requirement rather than a convenience:
 * telling them apart would confirm attentions of other sites to whoever
 * guesses identifiers, one at a time. `AGENDA_ENTRY_NOT_FOUND` and
 * `WAITLIST_ENTRY_NOT_FOUND` take the same line for the same reason.
 */
export class EncounterNotFoundError extends NotFoundError {
  readonly code = 'ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'Esa atención no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Encounter not found within the caller site scope');
  }
}

/**
 * EN-001. The chart named has no open history: it does not exist, or a merge
 * absorbed it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT IS A CONFLICT AND NOT A «PACIENTE NO ENCONTRADO»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 4 of A.M. 00115-2021 requires the history to be OPEN BEFORE the
 * attention starts. What this refuses is the shortcut of opening the attention
 * first and inventing the chart afterwards with whatever the doctor remembers
 * — which is how the duplicates PA-043 exists to repair get created. The way
 * out is to register the patient, and the sentence says so.
 *
 * ⚠️ AN ABSORBED CHART LANDS HERE TOO AND ITS SURVIVING NUMBER IS *NOT* NAMED.
 * `PatientMergedError` publishes the surviving MRN, and that is right on a
 * route of the patient register, where the caller already holds the chart.
 * Here the caller may hold nothing at all, so the MRN of somebody else's chart
 * would be a datum this endpoint handed out one guess at a time.
 */
export class PatientChartNotOpenError extends ConflictError {
  readonly code = 'PATIENT_CHART_NOT_OPEN';
  override readonly userTitle =
    'Ese paciente no tiene historia clínica abierta. Regístrelo en el fichero antes de abrir la atención';

  constructor() {
    super('Patient chart does not exist or was absorbed by a merge', {}, [
      {
        field: 'patientId',
        code: 'PATIENT_CHART_NOT_OPEN',
        message: 'Seleccione un paciente con ficha vigente',
      },
    ]);
  }
}

/**
 * EN-004. The appointment named belongs to a different patient.
 *
 * `trg_encounter_matches_appointment` refuses the row anyway — Prisma cannot
 * express a composite foreign key across two tables — and this is what turns
 * that refusal into a sentence. The service checks it first because the
 * mistake it catches is THE WORST ONE THIS SYSTEM CAN MAKE: attending the
 * wrong patient in somebody else's slot writes the act into the wrong history.
 *
 * NEITHER PATIENT IS NAMED (EN-124): answering «esa cita es de otra persona»
 * is already the whole of what the caller needs.
 */
export class EncounterAppointmentMismatchError extends BusinessRuleViolation {
  readonly code = 'ENCOUNTER_APPOINTMENT_MISMATCH';
  override readonly userTitle =
    'La cita indicada es de otro paciente. Elija la cita creada para esta persona';

  constructor() {
    super('Named appointment belongs to a different patient', {}, [
      {
        field: 'agendaEntryId',
        code: 'ENCOUNTER_APPOINTMENT_MISMATCH',
        message: 'Esa cita no es de este paciente',
      },
    ]);
  }
}

/**
 * EN-005. The appointment was annulled, marked absent or left without being
 * seen, and an attention cannot be filed against it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE REVERSE OF `AGENDA_ENTRY_HAS_ENCOUNTER`, AND IT CLOSES AG-045.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That one is emitted by `agenda` when somebody annuls a cita that already has
 * an attention. This one is emitted here when somebody attends a cita that was
 * already annulled. The two halves are the same race seen from either side,
 * and until this module existed only one of them was closed: the agenda's
 * `UPDATE` re-arbitrates on `encounter IS NULL`, and NOTHING tied the creation
 * of an attention to the state of the cita. The adapter locks the agenda row
 * inside the same transaction, so exactly one of the two operations wins.
 *
 * 409 AND NOT 422: the body is well formed and the appointment exists. What
 * refuses it is the state a colleague left it in, and the way out is to open
 * the attention without a cita (EN-003) — which the sentence says.
 */
export class AppointmentNotAttendableError extends ConflictError {
  readonly code = 'APPOINTMENT_NOT_ATTENDABLE';
  override readonly userTitle =
    'Esa cita ya está anulada o marcada como inasistencia: no se puede registrar una atención sobre ella. Abra la atención sin cita';

  constructor() {
    super('Named appointment is annulled or marked as an absence');
  }
}

/**
 * EN-009, EN-130. Clinical content was written into an attention that is no
 * longer open.
 *
 * 409 AND NOT 403: nobody lacks a permission — the act finished. The way out
 * is an amendment (EN-025) when there is something to correct, and a new
 * attention when there is something new to say (EN-006, which is why «tantas
 * atenciones como consultas» is not a workaround but the rule).
 */
export class EncounterAlreadyClosedError extends ConflictError {
  readonly code = 'ENCOUNTER_ALREADY_CLOSED';
  override readonly userTitle: string;

  constructor(status: EncounterStatus) {
    // The state only: no patient, no diagnosis, no hour reaches a log.
    super(`Encounter is ${status} and admits no new clinical content`, {
      status,
    });
    this.userTitle =
      `La atención está en estado «${STATUS_LABEL[status]}» y ya no admite contenido clínico nuevo. ` +
      'Para corregir lo escrito, enmiende la nota; para algo nuevo, abra otra atención';
  }
}

/**
 * EN-009. Closing — or discharging — without saying how the attention ended.
 *
 * ⚠️ IT IS WHY THERE IS NO AUTOMATIC CLOSURE (EN-145). A nightly job closing
 * yesterday's attentions would have to INVENT this value: `ALIVE` asserts the
 * patient came out well of a consultation nobody finished, and `ABANDONED`
 * accuses the patient of leaving when it may have been the doctor who ran out.
 * A datum invented by a scheduled process is indistinguishable from one a
 * person recorded, which is the real reason — it contaminates the record
 * leaving no trace that it was contaminated.
 */
export class DischargeConditionRequiredError extends ValidationError {
  readonly code = 'DISCHARGE_CONDITION_REQUIRED';
  override readonly userTitle =
    'Indique cómo termina la atención: el paciente sale por su cuenta, se lo refiere, falleció o abandonó';
  override readonly fieldErrors = [
    {
      field: 'dischargeCondition',
      code: 'DISCHARGE_CONDITION_REQUIRED',
      message: 'Valores admitidos: ALIVE, REFERRED, DECEASED, ABANDONED',
    },
  ];

  constructor() {
    super('A discharge condition is required to discharge or close');
  }
}

/**
 * EN-132. The requested pair is not in the table of SPEC §11.
 *
 * A CONFLICT (409) and not a validation error: the request was well formed and
 * it is the CURRENT STATE that refuses it — usually because a colleague moved
 * it first. The title names that state and what can be done from there, which
 * is the one thing the caller's screen no longer knows; `params` carries both
 * ends in stable codes for a client that branches.
 *
 * ONE CODE FOR EVERY REFUSED PAIR, exactly as the SPEC's error table says.
 * Reopening a closed attention, skipping the clinical discharge and suspending
 * one already discharged are the same fact — «desde donde está, eso no» — and
 * three codes would only ask every client to enumerate a table it does not own.
 */
export class InvalidEncounterTransitionError extends ConflictError {
  readonly code = 'ENCOUNTER_STATE_TRANSITION_INVALID';
  override readonly userTitle: string;

  constructor(from: EncounterStatus, to: EncounterStatus) {
    // State codes only: no patient, practitioner or instant reaches a log.
    super(`Transition ${from} to ${to} is not admitted`, { from, to });
    this.userTitle = `La atención está en estado «${STATUS_LABEL[from]}» y ${WHAT_TO_DO[from]}. Actualice la pantalla`;
  }
}

/**
 * EN-144, EN-147. Somebody who did not open the attention tried to close it
 * without holding `record:sign`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WITH `record:sign` THIS DOES NOT FIRE — the closure happens and leaves the
 * constancia of the substitution.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-A-010: the case is that whoever opened it is no longer here — holidays,
 * sick leave, left the clinic — and the attention cannot stay open for ever.
 * What the substitution costs is a written reason, and
 * `encounter_substitute_closure_states_reason` enforces it in the database:
 * either the closer is the practitioner who gave the attention, or there is a
 * reason. Without that constancia a substitute closure reads, twelve months
 * later, as though the attending doctor had done it.
 *
 * 403 AND NOT 422: nothing sent is wrong. What is missing is authority, and
 * the way out is to ask somebody who signs, not to correct a field.
 */
export class EncounterCloserNotAuthorError extends ForbiddenError {
  readonly code = 'ENCOUNTER_CLOSER_NOT_AUTHOR';
  override readonly userTitle =
    'Esta atención la cierra el profesional que la abrió. Si no está disponible, debe cerrarla alguien que firme historia clínica, indicando el motivo';

  constructor() {
    super('Closer is neither the attending practitioner nor a signer');
  }
}

/**
 * EN-147. A substitute closure with no reason written.
 *
 * DEMANDED IN THE SERVICE AND NOT ONLY IN THE DTO, for the same reason
 * `CANCELLATION_REASON_REQUIRED` is in the agenda: a `DEBERÁ` that only the
 * transport enforces stops being true the first time an internal caller closes
 * one. The base says it a third time.
 *
 * FREE TEXT AND NOT A DROPDOWN, like the amendment reason of EN-025: a
 * dropdown gets filled in on autopilot, a text box does not.
 */
export class SubstituteClosureReasonRequiredError extends ValidationError {
  readonly code = 'SUBSTITUTE_CLOSURE_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué cierra esta atención otra persona. Queda registrado junto a la atención';
  override readonly fieldErrors = [
    {
      field: 'substituteReason',
      code: 'SUBSTITUTE_CLOSURE_REASON_REQUIRED',
      message: 'Indique por qué la cierra usted y no quien la abrió',
    },
  ];

  constructor() {
    super('Substitute closure requested without a reason');
  }
}

/**
 * The caller has an account but no clinical profile, and the act being asked
 * for is one only a practitioner performs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CODE OF ITS OWN AND NOT A BARE 403
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The columns that record authorship — `encounter.closed_by_id`,
 * `clinical_note.author_id`, `clinical_note.signed_by_id` — are foreign keys
 * to `practitioner`, not to `app_user`, and that is the schema saying that a
 * clinical act has a clinical author. A receptionist who somehow held
 * `record:write` would otherwise be refused by a foreign key with a
 * `RELATED_RECORD_MISSING` on a form where nothing is wrong.
 *
 * NOTHING ABOUT THE ACCOUNT IS NAMED: the answer is the same for an account
 * with no profile and one whose profile was deactivated, so the endpoint does
 * not become a directory of who is a practitioner here.
 */
export class PractitionerProfileRequiredError extends ForbiddenError {
  readonly code = 'PRACTITIONER_PROFILE_REQUIRED';
  override readonly userTitle =
    'Su cuenta no tiene ficha profesional activa, y este registro va firmado por un profesional. Pida que se la creen';

  constructor() {
    super('Caller has no active practitioner profile');
  }
}

/**
 * EN-029, REQ-041. The ACESS registration of whoever is signing has expired.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHECKED WHEN SIGNING, NEVER WHEN THE PRACTITIONER WAS REGISTERED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A registration that lapses on Tuesday stops enabling on Wednesday without
 * anybody touching a row, so the only instant at which the question can be
 * answered truthfully is the instant of the signature. `staff` asks the same
 * question when it hires (ST-004) and answers `ACESS_EXPIRED`; this is a
 * DIFFERENT question — «may this person sign THIS note TODAY» — and it gets a
 * code of its own so a client can tell «no puede firmar» from «no se puede dar
 * de alta». Both rules stay where their reason to exist is: no module imports
 * another.
 *
 * NO DATE AND NO REGISTRATION NUMBER in the message: it reaches the logs, and
 * neither is the caller's to be told by this endpoint.
 */
export class PractitionerNotLicensedError extends ForbiddenError {
  readonly code = 'PRACTITIONER_NOT_LICENSED';
  override readonly userTitle =
    'Su registro ACESS no está vigente, así que no puede firmar historia clínica. Actualícelo con administración';

  constructor() {
    super('Signing practitioner holds no ACESS registration in force');
  }
}

/* ─── Signos vitales (H4: EN-060 a EN-068) ───────────────────────────────── */

/**
 * EN-061. The body carried a body mass index.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REFUSED AND NOT IGNORED, WHICH IS THE WHOLE REQUIREMENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `trg_encounter_vitals_bmi` overwrites the column on every insert and update,
 * so a supplied value could never be stored — dropping it silently would leave
 * the caller believing the figure they typed is the one in the record. It is
 * not, and the day the two differ the screen and the chart disagree about a
 * number that decides a nutritional referral. Refusing is the only answer that
 * cannot be misread.
 *
 * 422 with the field named, so the form knows which box to remove.
 */
export class BmiIsDerivedError extends ValidationError {
  readonly code = 'BMI_IS_DERIVED';
  override readonly userTitle =
    'El índice de masa corporal lo calcula el sistema: registre el peso y la talla y no lo escriba';
  override readonly fieldErrors = [
    {
      field: 'bmi',
      code: 'BMI_IS_DERIVED',
      message: 'No escriba el IMC: se calcula con el peso y la talla',
    },
  ];

  constructor() {
    super('BMI is computed by the database and may not be supplied');
  }
}

/** EN-063, EN-217. How each measurement is named in a refusal. */
const ANTHROPOMETRY_LABELS: Readonly<Record<string, string>> = {
  weightKg: 'Peso',
  heightCm: 'Talla',
  headCircumferenceCm: 'Perímetro cefálico',
};

/**
 * EN-217 (D-132 B). Signing the consultation note — which discharges the
 * attention — with the anthropometry the instructivo makes obligatory still
 * missing (EN-063): weight, height and head circumference of an under-five,
 * weight and height of a pregnant woman.
 *
 * AT THE SIGNATURE AND NOT AT THE TAKING. Refusing the whole taking lost the
 * blood pressure of a pregnant woman who could not be weighed — the figure
 * that warns of pre-eclampsia — or made somebody type an invented weight.
 *
 * AND AFTER THE DISCHARGE (D-134.3), a correction of the taking that would
 * leave one missing: the signature demanded it, and the correction cannot
 * take it away again. Same code — the screen does the same thing, fill the
 * box — and a sentence of its own, because «para firmar la nota» says nothing
 * to somebody correcting a taking whose note is already signed.
 *
 * THE MISSING FIELDS ARE NAMED ONE BY ONE: «faltan datos» sends somebody round
 * a form where three boxes could be the one.
 */
export class AnthropometryPendingError extends ValidationError {
  readonly code = 'ANTHROPOMETRY_PENDING';
  override readonly userTitle: string;

  constructor(
    missing: readonly string[],
    moment: 'signature' | 'correctionAfterDischarge' = 'signature',
  ) {
    const afterDischarge = moment === 'correctionAfterDischarge';
    super(
      `Mandatory anthropometry missing ${afterDischarge ? 'after a correction of a discharged attention' : 'at signature'}: ${missing.join(', ')}`,
      { missing: missing.join(',') },
      missing.map((field) => ({
        field,
        code: 'ANTHROPOMETRY_PENDING',
        // Named, because the screen joins the messages of several fields into
        // one line, and three identical sentences say nothing.
        message: `${ANTHROPOMETRY_LABELS[field] ?? field}: ${afterDischarge ? 'obligatorio tras el alta, no se puede quitar' : 'obligatorio para firmar la nota'}`,
      })),
    );
    this.userTitle = afterDischarge
      ? 'La atención ya tiene el alta: la corrección no puede dejar sin peso/talla obligatorios'
      : 'Falta peso/talla: obligatorio para firmar la nota';
  }
}

/* ─── Nota clínica (H2: EN-020 a EN-034) ─────────────────────────────────── */

/** EN-022. The note does not exist, or belongs to another attention. */
export class ClinicalNoteNotFoundError extends NotFoundError {
  readonly code = 'CLINICAL_NOTE_NOT_FOUND';
  override readonly userTitle =
    'Esa nota no existe en esta atención. Actualice la pantalla';

  constructor() {
    super('Clinical note not found within this encounter');
  }
}

/**
 * EN-021. The form code and version asked for are not among the ones this
 * installation knows how to validate.
 *
 * ⚠️ THE CODE IS DATA AND THE FORM IS NOT — and both halves are the
 * requirement. `clinical_note.form_code` is a `VarChar(8)` precisely so a
 * renumbering by the ministry costs an UPDATE rather than a migration
 * (EN-021), and the A.M. 00115-2021 went from 16 forms to 51. What may NOT be
 * free is which shapes this system can validate: a note stored under a code
 * nobody declared is a note nothing can check, print or amend, and it would be
 * discovered years later by whoever has to produce it.
 *
 * 422 naming the codes admitted, so a client can correct rather than guess.
 */
export class UnknownClinicalFormError extends ValidationError {
  readonly code = 'UNKNOWN_CLINICAL_FORM';
  override readonly userTitle =
    'Ese formulario no está configurado en el sistema. Elija uno de los formularios disponibles';

  constructor(admitted: readonly string[]) {
    super(`Form is not registered; admitted: ${admitted.join(', ')}`, {
      admitted: admitted.join(','),
    });
    // The admitted codes are MSP form numbers, not patient data: naming them
    // is what makes the refusal actionable.
  }
}

/**
 * EN-020. The form was signed — or saved — without a section the art. 6 of the
 * A.M. 00115-2021 lists as minimum content.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE LIST IS ENUMERATED AND NOT REFERENCED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «El contenido mínimo del reglamento» specifies nothing; the list does. It
 * lives in `clinical-note.ts`, beside the registry that carries it, and the
 * error only names the sections that are missing — never their contents, which
 * are the reason for the visit and the present illness.
 */
export class NoteContentIncompleteError extends ValidationError {
  readonly code = 'NOTE_CONTENT_INCOMPLETE';
  override readonly userTitle =
    'Faltan secciones obligatorias del formulario. Complételas antes de firmar';

  /**
   * EN-205. `invalid` are the list sections holding a value that is not one
   * of their options: the same refusal, because what the doctor does next is
   * the same — fix the section named before signing.
   */
  constructor(
    missing: readonly string[],
    invalid: readonly string[] = [],
    /** EN-020. The 002 discharges the attention, and that needs a diagnosis. */
    withoutDiagnosis = false,
  ) {
    const named = withoutDiagnosis ? [...missing, 'diagnoses'] : missing;
    super(
      `Form is missing mandatory sections: ${named.join(', ')}`,
      { missing: named.join(','), invalid: invalid.join(',') },
      [
        ...missing.map((section) => ({
          field: `content.${section}`,
          code: 'NOTE_CONTENT_INCOMPLETE',
          message: 'Sección obligatoria del formulario',
        })),
        ...invalid.map((section) => ({
          field: `content.${section}`,
          code: 'NOTE_CONTENT_INCOMPLETE',
          message: 'Elija una de las opciones de la lista',
        })),
        ...(withoutDiagnosis
          ? [
              {
                field: 'diagnoses',
                code: 'NOTE_CONTENT_INCOMPLETE',
                message: 'Registre al menos un diagnóstico antes de firmar',
              },
            ]
          : []),
      ],
    );
  }
}

/**
 * EN-201, EN-202. A version of the note template that cannot be published:
 * a minimum section removed or made optional, a list without two distinct
 * options, two sections with one title. The field names the section.
 */
export class NoteTemplateInvalidError extends ValidationError {
  readonly code = 'NOTE_TEMPLATE_INVALID';
  override readonly userTitle =
    'La plantilla de la nota no se puede publicar así';

  constructor(field: string, message: string) {
    super(`Note template refused at ${field}`, { field }, [
      { field, code: 'NOTE_TEMPLATE_INVALID', message },
    ]);
  }
}

/**
 * EN-023, REQ-005. Somebody tried to edit a note that is already signed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSLATED BY THE SERVICE, NOT BY THE CONSTRAINT MAP, AND THE SPEC SAYS WHY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `trg_clinical_note_immutable` raises `insufficient_privilege` (42501), which
 * on its own would come out as a 403 telling the doctor they lack permissions
 * when what happened is that the note is signed. The database is still the
 * guarantee — it is the only thing that also stops a `psql`, an import or a
 * use case somebody writes in two years without reading this spec — and this
 * class is what the service throws BEFORE reaching it, so the sentence is
 * about the note rather than about privileges.
 *
 * 409: nothing sent is wrong, the note moved on, and the way out is an
 * amendment, which the sentence names.
 */
export class NoteAlreadySignedError extends ConflictError {
  readonly code = 'NOTE_ALREADY_SIGNED';
  override readonly userTitle =
    'Esa nota ya está firmada y no se puede editar. Para corregirla, enmiéndela indicando el motivo';

  constructor() {
    super('Signed clinical notes are immutable');
  }
}

/**
 * EN-025. An amendment with no written reason.
 *
 * DEMANDED IN THE SERVICE AND NOT ONLY IN THE DTO — a `DEBERÁ` the transport
 * alone enforces stops being true the first time an internal caller amends one
 * — and `clinical_note_amendment_reason` demands it a third time in the base.
 *
 * FREE TEXT AND NOT A DROPDOWN, which the schema comment already argues: *«un
 * desplegable se rellena en piloto automático; un cuadro de texto no»*. The
 * amendment is a clinical act that has to be readable and citable in a legal
 * proceeding, and «Otro» is not a reason anybody can cite.
 */
export class AmendmentReasonRequiredError extends ValidationError {
  readonly code = 'AMENDMENT_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué enmienda la nota. Queda escrito junto a la versión nueva y la anterior sigue siendo legible';
  override readonly fieldErrors = [
    {
      field: 'amendmentReason',
      code: 'AMENDMENT_REASON_REQUIRED',
      message: 'Indique el motivo de la enmienda',
    },
  ];

  constructor() {
    super('Amendment requested without a reason');
  }
}

/**
 * EN-166, EN-218. What still stands in the attention, one paper at a time:
 * each is retracted by its own door before the attention can say it never
 * existed. Drafts are not here: the annulment discards them in the same act.
 */
export interface LivePaper {
  kind:
    | 'prescriptions'
    | 'orders'
    | 'signedNotes'
    | 'certificates'
    | 'referrals'
    | 'interconsultations';
  id: string;
  /** The paper's own number, when it has one: how the user finds it. */
  number: number | null;
}

/** How each paper is named, with what still makes it stand. */
const LIVE_PAPER_LABELS: Readonly<
  Record<LivePaper['kind'], { article: string; noun: string; state: string }>
> = {
  prescriptions: { article: 'la', noun: 'receta', state: 'emitida' },
  orders: { article: 'la', noun: 'orden de exámenes', state: 'con exámenes pendientes' }, // prettier-ignore
  signedNotes: { article: 'la', noun: 'nota', state: 'firmada' },
  certificates: { article: 'el', noun: 'certificado', state: 'sin anular' },
  referrals: { article: 'la', noun: 'referencia', state: 'emitida' },
  interconsultations: { article: 'la', noun: 'interconsulta', state: 'pedida' },
};

function paperName(paper: LivePaper): string {
  const label = LIVE_PAPER_LABELS[paper.kind];
  return paper.number === null
    ? label.noun
    : `${label.noun} N.º ${paper.number}`;
}

/**
 * EN-166, D-099 §1, EN-218. The attention already left something in the chart
 * —a prescription issued, an order with exams pending, a signed note, a
 * certificate not revoked, a referral or an interconsultation (D-103)— and it
 * is retracted by its own door before the attention is annulled.
 *
 * EACH PAPER BY NAME (AT-22): the sentence says which, with its number, and
 * `errors[]` carries one entry per paper (`acts.<kind>.<id>`) so the screen
 * offers its own «Anular» or «Corregir» beside it. Numbers and kinds only: no
 * patient, no drug, no exam.
 */
export class EncounterHasLiveActsError extends ConflictError {
  readonly code = 'ENCOUNTER_HAS_LIVE_ACTS';
  override readonly userTitle: string;

  constructor(papers: readonly LivePaper[]) {
    const counts: Record<string, number> = {};
    for (const paper of papers) counts[paper.kind] = (counts[paper.kind] ?? 0) + 1; // prettier-ignore
    super(
      'Encounter holds acts that have to be retracted first',
      counts,
      papers.map((paper) => {
        const label = LIVE_PAPER_LABELS[paper.kind];
        const name = paperName(paper);
        return {
          field: `acts.${paper.kind}.${paper.id}`,
          code: 'ENCOUNTER_HAS_LIVE_ACTS',
          message: `${name[0]!.toUpperCase()}${name.slice(1)} ${label.state}`,
        };
      }),
    );
    const named = papers.map(
      (paper) => `${LIVE_PAPER_LABELS[paper.kind].article} ${paperName(paper)}`,
    );
    // A referral already seen elsewhere or an answered interconsultation has
    // no way back (D-103): the sentence says so instead of sending the user
    // to a door that does not exist (4.ª revisión, m3).
    this.userTitle = `Antes de anular la atención, anule ${named.join(', ')}; si alguno ya no se puede anular, esta atención no se anula`;
  }
}

/**
 * EN-167, D-099 §2. The appointment's arrival was never recorded, so it cannot
 * be closed as attended nor as «se fue sin ser atendido».
 */
export class AppointmentArrivalNotRecordedError extends ConflictError {
  readonly code = 'APPOINTMENT_ARRIVAL_NOT_RECORDED';
  override readonly userTitle =
    'La cita no tiene registrada la llegada. Regístrela (con la calificación de emergencia) antes de interrumpir la atención';

  constructor() {
    super('Appointment arrival is not recorded');
  }
}

/**
 * EN-167, D-085 §2. The attention holds a draft written by SOMEBODY
 * ELSE. Interrupting signs the drafts of whoever interrupts (D-082); a draft of
 * another author would stay unsigned inside a terminal attention, where nobody
 * could sign it any more — the «texto sin responsable» D-082 rejected.
 *
 * EN-218. And annulling discards the drafts of whoever annuls: a prescription
 * or an order still in draft of ANOTHER prescriber or signer is theirs to
 * issue or discard (PR-100, D-123.1). Same code — the way out is the same,
 * the other person acts first — and a sentence for each act.
 */
export class EncounterHasOthersDraftsError extends ConflictError {
  readonly code = 'ENCOUNTER_HAS_OTHERS_DRAFTS';
  override readonly userTitle: string;

  constructor(act: 'interruption' | 'annulment' = 'interruption') {
    super(
      act === 'annulment'
        ? 'Encounter holds a draft prescription or order of another practitioner'
        : 'Encounter holds a draft note of another author',
    );
    this.userTitle =
      act === 'annulment'
        ? 'La atención tiene una receta u orden en borrador de otro profesional. Que la emita o la descarte antes de anular'
        : 'La atención tiene una nota en borrador de otra persona. Que la firme o la descarte antes de interrumpir';
  }
}

/**
 * EN-129, EN-167 (D-076, D-082). An interruption without its written reason
 * or without saying where it came from — the patient or the clinic.
 */
export class EncounterInterruptionReasonRequiredError extends ValidationError {
  readonly code = 'ENCOUNTER_INTERRUPTION_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué se interrumpe la atención y si la interrupción vino del paciente o del establecimiento';
  override readonly fieldErrors: {
    field: string;
    code: string;
    message: string;
  }[];

  constructor(missing: { reason: boolean; origin: boolean }) {
    super('Encounter interruption requested without a reason or an origin');
    this.fieldErrors = [
      ...(missing.reason
        ? [{ field: 'reason', code: this.code, message: 'Indique el motivo de la interrupción' }] // prettier-ignore
        : []),
      ...(missing.origin
        ? [{ field: 'origin', code: this.code, message: 'Indique si la interrupción vino del paciente o del establecimiento' }] // prettier-ignore
        : []),
    ];
  }
}

/**
 * EN-025, EN-026. The version named cannot be amended or retracted: it is a
 * draft, it was already superseded, or it was already retracted.
 *
 * ONE CODE FOR THE THREE, and the message is what differs: what a caller does
 * next is the same in all of them — go to the version that IS current — and
 * three codes would ask every client to model the chain's lifecycle.
 *
 * A DRAFT LANDS HERE ON PURPOSE. Amending a draft is not an amendment: the
 * draft is still editable, so a new version would leave two rows saying the
 * same thing and the chain would carry a version that never was a note. And
 * `clinical_note_one_current_per_chain` would refuse the second one anyway,
 * with a constraint name instead of this sentence.
 */
export class NoteNotAmendableError extends ConflictError {
  readonly code = 'NOTE_NOT_AMENDABLE';
  override readonly userTitle: string;

  constructor(status: NoteStatus) {
    super(`A note in status ${status} cannot be amended or retracted`, {
      status,
    });
    this.userTitle =
      status === 'DRAFT'
        ? 'Esa nota todavía es un borrador: edítela y fírmela, no hace falta enmendarla'
        : 'Esa versión ya no es la vigente. Abra la versión actual de la nota y actúe sobre ella';
  }
}

/**
 * What to tell the user for each catalogue this refusal can name.
 *
 * A TABLE AND NOT A TERNARY. With two catalogues a ternary reads fine; with
 * three it silently makes «anything that is not CIE-10» mean «el tarifario»,
 * which is how an allergy to penicillin came to be answered with «búsquelo en
 * el catálogo de prestaciones». The sentence has to name the list the caller
 * should actually open.
 *
 * ⚠️ AND THE UNION IS CLOSED, so a fourth catalogue fails to COMPILE here
 * rather than falling through to a sentence that names the wrong list.
 */
type ExpectedCatalogue = 'CIE10' | 'TARIFF' | 'CNMB';

const WRONG_CATALOGUE_TITLE: Readonly<Record<ExpectedCatalogue, string>> = {
  CIE10:
    'Ese código no es un diagnóstico CIE-10. Búsquelo en el catálogo de diagnósticos',
  TARIFF:
    'Ese código no es un procedimiento del tarifario. Búsquelo en el catálogo de prestaciones',
  CNMB: 'Ese código no es un medicamento del CNMB. Busque el principio activo en el cuadro de medicamentos',
};

/**
 * EN-040, EN-050. The concept named exists, and belongs to the wrong
 * catalogue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOLE THE FOREIGN KEY DOES NOT COVER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `encounter_diagnosis.concept_id` is a foreign key to `catalog_concept`, and
 * `catalog_concept` holds EVERY catalogue: CIE-10, the tariff, the DPA, the
 * ethnicities. So the key proves the row exists and proves nothing about what
 * kind of thing it is, and `trg_diagnosis_snapshot` does not help either — it
 * only checks that the frozen code matches the concept, which a parish code
 * matches perfectly well. Nothing in the database stops a canton being filed
 * as a diagnosis, and once filed it is a diagnosis for ever.
 *
 * ONE CODE FOR BOTH SIDES OF BLOCK K, and the message says which catalogue was
 * expected: what a caller does next is identical — pick from the right list —
 * and two codes would ask every client to model the difference.
 *
 * 422: the request is wrong, the server is not, and the field that is wrong is
 * named.
 */
export class ConceptWrongCatalogueError extends ValidationError {
  readonly code = 'CONCEPT_WRONG_CATALOGUE';
  override readonly userTitle: string;
  override readonly fieldErrors: readonly {
    field: string;
    code: string;
    message: string;
  }[];

  constructor(expectedCatalogue: ExpectedCatalogue) {
    super(`The concept does not belong to the ${expectedCatalogue} catalogue`, {
      expectedCatalogue,
    });
    this.userTitle = WRONG_CATALOGUE_TITLE[expectedCatalogue];
    this.fieldErrors = [
      {
        // EN-080. The CNMB case names `substanceConceptId`, which is the field
        // the allergy form actually has. A field error pointing at a field the
        // form does not contain is one no screen can paint.
        field:
          expectedCatalogue === 'CNMB' ? 'substanceConceptId' : 'conceptId',
        code: 'CONCEPT_WRONG_CATALOGUE',
        message: this.userTitle,
      },
    ];
  }
}

/**
 * EN-042, REQ-029. The CIE-10 code was not in force on the day of the
 * attention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATABASE IS THE GUARANTEE; THIS IS THE SENTENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `trg_diagnosis_concept_in_force` checks `valid_period @> (started_at AT TIME
 * ZONE 'America/Guayaquil')::date`, and it is what also stops an import, a
 * `psql` and a use case somebody writes in two years. What it CANNOT do is
 * produce this sentence: it raises `integrity_constraint_violation` from
 * PL/pgSQL, so PostgreSQL emits no «violates … constraint "…"» clause and the
 * name never travels — the mapping in `database-problem.ts` can only answer
 * the class code, `INTEGRITY_RULE_FAILED`, which tells a doctor nothing about
 * which code to pick instead.
 *
 * So the adapter asks the SAME question inside the same transaction and throws
 * this. It is the order `NOTE_ALREADY_SIGNED` already uses: trigger first as
 * the rule, application second as the explanation.
 *
 * ⚠️ AND THE CODE IS NOT NAMED IN THE MESSAGE. The trigger's own comment says
 * why it stopped interpolating the concept id: values under client control in
 * an error message let a caller steer which error the API reports back. The
 * sentence here says what to do, never which row failed.
 *
 * 422: nothing about the system is broken. The diagnosis has to be coded with
 * the edition that was in force the day the patient was seen, which is what
 * makes a report reprocessed in five years come out the same.
 */
export class DiagnosisConceptNotInForceError extends ValidationError {
  readonly code = 'DIAGNOSIS_CONCEPT_NOT_IN_FORCE';
  override readonly userTitle =
    'Ese código CIE-10 no estaba vigente el día de esta atención. Elija el que regía en esa fecha';
  override readonly fieldErrors = [
    {
      field: 'conceptId',
      code: 'DIAGNOSIS_CONCEPT_NOT_IN_FORCE',
      message: 'El código no estaba vigente en la fecha de la atención',
    },
  ];

  constructor() {
    super('CIE-10 concept was not in force on the encounter date');
  }
}

/**
 * EN-043. A second principal diagnosis.
 *
 * GUARANTEED BY `encounter_diagnosis_one_primary`, a partial unique index `ON
 * encounter_diagnosis (encounter_id) WHERE rank = 1`. The adapter reads the
 * rank in use inside the same transaction so the refusal is this sentence, and
 * the index arbitrates the two writers who read «libre» in the same
 * millisecond — the same division of labour as every other race in this
 * module.
 *
 * 409 AND NOT 422: nothing sent is wrong. There is already a principal
 * diagnosis, and what the caller does next is decide which of the two it is —
 * which the message says.
 */
export class DiagnosisPrimaryTakenError extends ConflictError {
  readonly code = 'DIAGNOSIS_PRIMARY_TAKEN';
  override readonly userTitle =
    'Esta atención ya tiene un diagnóstico principal. Registre éste como secundario, o cambie primero cuál es el principal';
  override readonly fieldErrors = [
    {
      field: 'rank',
      code: 'DIAGNOSIS_PRIMARY_TAKEN',
      message: 'Ya hay un diagnóstico principal en esta atención',
    },
  ];

  constructor() {
    super('The encounter already has a primary diagnosis');
  }
}

/**
 * EN-082. The allergy named is not on this chart, nor on any chart it
 * absorbed.
 *
 * ONE ANSWER FOR «NO EXISTE» AND FOR «ES DE OTRA FICHA», the line
 * `ENCOUNTER_NOT_FOUND` already took: telling them apart would confirm, one
 * guess at a time, that a given identifier is an allergy of somebody else's
 * chart — and «esta persona tiene una alergia registrada» is clinical
 * information about a patient the caller may hold nothing on.
 *
 * ⚠️ AND THE LOOKUP THAT PRODUCES IT GOES THROUGH THE CHART SCOPE. An allergy
 * written on an absorbed chart IS refutable from the survivor: after a merge
 * there is one person, and a 404 there would tell a doctor that the penicillin
 * allergy on their screen does not exist.
 */
export class PatientAllergyNotFoundError extends NotFoundError {
  readonly code = 'PATIENT_ALLERGY_NOT_FOUND';
  override readonly userTitle =
    'Esa alergia no consta en la historia de este paciente. Actualice la lista';

  constructor() {
    super('Allergy not found within the chart scope');
  }
}

/**
 * EN-082. The allergy had already been ruled out.
 *
 * ⚠️ NOT TREATED AS IDEMPOTENT, AND THAT IS THE REQUIREMENT. Accepting the
 * second refutation would overwrite `refuted_at` and `refuted_notes` with
 * today's date and today's reason — and who ruled an allergy out and why is
 * «información clínica por derecho propio», which is the entire argument for
 * marking instead of deleting. Silently replacing it deletes it in slow
 * motion.
 *
 * 409 AND NOT 422: the request is well formed and the allergy exists. What
 * refuses it is the state a colleague left it in.
 */
export class AllergyAlreadyRefutedError extends ConflictError {
  readonly code = 'ALLERGY_ALREADY_REFUTED';
  override readonly userTitle =
    'Esa alergia ya está descartada. Si se descartó por error, reactívela';

  constructor() {
    super('Allergy has already been refuted');
  }
}

/**
 * EN-224, D-140.1. An allergy of HIGH criticality was ruled out without a
 * reason. Back from its retirement with a narrower rule: any other allergy is
 * ruled out without one (D-126.2), but this one is the anaphylaxis, and a
 * refutation nobody can weigh is the risk to the patient D-126.4 excepts.
 *
 * RAISED BY THE ADAPTER UNDER THE ROW LOCK, where the criticality is the one
 * that stands: a colleague may have just raised it from «baja» to «alta».
 * 422 with the field named: the way out is to choose a reason.
 */
export class RefutationReasonRequiredError extends ValidationError {
  readonly code = 'REFUTATION_REASON_REQUIRED';
  override readonly userTitle =
    'Elija por qué se descarta: es una alergia de criticidad alta';
  override readonly fieldErrors = [
    {
      field: 'notes',
      code: 'REFUTATION_REASON_REQUIRED',
      message: 'Elija un motivo para descartar una alergia de criticidad alta',
    },
  ];

  constructor() {
    super('Refuting a high-criticality allergy requires a reason');
  }
}

/**
 * EN-226, D-140.3. «Descartar estas y afirmar» named an allergy of HIGH
 * criticality. Those are ruled out one by one, each with its reason
 * (`REFUTATION_REASON_REQUIRED`), never as the side effect of asserting
 * «sin alergias conocidas». 409: the request is well formed and what refuses
 * it is what the chart holds; nothing is ruled out.
 */
export class AllergyRefutedAloneError extends ConflictError {
  readonly code = 'ALLERGY_REFUTED_ALONE';
  override readonly userTitle =
    'Las alergias de criticidad alta se descartan una a una, con su motivo. Descártelas antes de afirmar';

  constructor() {
    super('A high-criticality allergy cannot be refuted in bulk');
  }
}

/**
 * EN-085. The history entry is on neither this chart nor one it absorbed.
 * One answer for «no existe» and «es de otra ficha», the line
 * `PATIENT_ALLERGY_NOT_FOUND` already took.
 */
export class PatientHistoryNotFoundError extends NotFoundError {
  readonly code = 'PATIENT_HISTORY_NOT_FOUND';
  override readonly userTitle =
    'Ese antecedente no consta en la historia de este paciente. Actualice la lista';

  constructor() {
    super('History entry not found within the chart scope');
  }
}

/**
 * EN-085. The entry had already been ruled out. NOT idempotent, for the
 * reason `ALLERGY_ALREADY_REFUTED` gives: a second refutation would overwrite
 * who ruled it out and why.
 */
export class HistoryAlreadyRefutedError extends ConflictError {
  readonly code = 'HISTORY_ALREADY_REFUTED';
  override readonly userTitle =
    'Ese antecedente ya está descartado. Si se descartó por error, reactívelo';

  constructor() {
    super('History entry has already been refuted');
  }
}

/**
 * EN-224. «Reactivar» an allergy that is not ruled out. 409: the allergy
 * exists and the request is well formed; what refuses it is its state, which
 * a colleague may have changed a moment ago.
 */
export class AllergyNotRefutedError extends ConflictError {
  readonly code = 'ALLERGY_NOT_REFUTED';
  override readonly userTitle =
    'Esa alergia no está descartada: sigue activa. Actualice la lista';

  constructor() {
    super('Allergy is not refuted');
  }
}

/** EN-224. The same as `ALLERGY_NOT_REFUTED`, for a history entry. */
export class HistoryNotRefutedError extends ConflictError {
  readonly code = 'HISTORY_NOT_REFUTED';
  override readonly userTitle =
    'Ese antecedente no está descartado: sigue activo. Actualice la lista';

  constructor() {
    super('History entry is not refuted');
  }
}

/**
 * EN-226. «Retirar» a «sin alergias conocidas» when the chart has none
 * standing: somebody retracted it a moment ago, or an allergy recorded since
 * already made it stop counting. 409, and the way out is to reload.
 */
export class NoKnownAllergiesNotStandingError extends ConflictError {
  readonly code = 'NO_KNOWN_ALLERGIES_NOT_STANDING';
  override readonly userTitle =
    'Esta ficha ya no tiene «Sin alergias conocidas» vigente. Actualice la ficha';

  constructor() {
    super('The chart has no standing no-known-allergies assertion');
  }
}

/**
 * EN-087. «Sin alergias conocidas» over a chart that has allergies on it.
 *
 * ⚠️ REFUSED AND NOT MERGED INTO A WARNING. The two statements cannot both be
 * on one chart: whoever reads «sin alergias conocidas» stops reading the list,
 * which is the whole reason the band says it at all. What the caller has to do
 * is refute the allergies that are no longer valid — since EN-226 in the same
 * step, naming each one (`…/none-known/refuting-active`): the list on the
 * screen is the clinical judgement, never a side effect of ticking a box.
 *
 * 409 AND NOT 422: the request is well formed and the chart exists. What
 * refuses it is what is already written on the record.
 *
 * ⚠️ RAISED HERE *AND* GUARDED BY `trg_patient_allergy_absence_empty_chart`.
 * The service can only see the state it read; two simultaneous requests —
 * recording an allergy and asserting there are none — both read a chart that
 * stops being true a millisecond later. Only the database arbitrates that, and
 * only this class turns it into a sentence somebody can act on.
 */
export class ChartHasAllergiesError extends ConflictError {
  readonly code = 'CHART_HAS_ALLERGIES';
  override readonly userTitle =
    'Esta ficha tiene alergias activas. Descártelas antes de afirmar que no hay ninguna';

  constructor() {
    super('Cannot assert no known allergies on a chart with active allergies');
  }
}

/**
 * EN-180, EN-183. The diagnosis named is not on this attention, or it was
 * already removed. One answer for both, the line `ENCOUNTER_NOT_FOUND` took.
 */
export class DiagnosisNotFoundError extends NotFoundError {
  readonly code = 'DIAGNOSIS_NOT_FOUND';
  override readonly userTitle =
    'Ese diagnóstico ya no consta en esta atención. Actualice la lista';

  constructor() {
    super('Diagnosis not found on the encounter');
  }
}

/**
 * EN-214 (D-126.3, D-117.9, D-117.14). Removing a diagnosis whose code a paper
 * in a third party's hands printed — an issued certificate or receta, in force
 * or annulled — states why: the paper does not change, and the history has to
 * explain why it says something else. Chosen from a list on the screen.
 * Demanded in the service, and by `trg_encounter_diagnosis_retraction_admits`
 * a second time. A signed note or the discharge no longer owe it (EN-213):
 * the screen confirms once.
 */
export class DiagnosisRetractionReasonRequiredError extends ValidationError {
  readonly code = 'DIAGNOSIS_RETRACTION_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué quita el diagnóstico: un certificado, una receta o una orden ya entregados lo imprimieron';
  override readonly fieldErrors = [
    {
      field: 'reason',
      code: 'DIAGNOSIS_RETRACTION_REASON_REQUIRED',
      message: 'Indique por qué quita el diagnóstico',
    },
  ];

  constructor() {
    super(
      'Diagnosis retraction without a reason while an issued paper printed it',
    );
  }
}

/**
 * EN-188 (revisión clínica G1). After the discharge nothing new is coded
 * (EN-009; whether it should be is D-117.12), so removing the LAST diagnosis
 * would leave a discharged attention with none and no way back — and the
 * RDACAA without its block K.
 */
export class DiagnosisLastAfterDischargeError extends ConflictError {
  readonly code = 'DIAGNOSIS_LAST_AFTER_DISCHARGE';
  override readonly userTitle =
    'Es el único diagnóstico de la atención y ya tiene el alta: no se puede quitar, porque la atención quedaría sin diagnóstico';

  constructor() {
    super('The last diagnosis of a discharged encounter cannot be removed');
  }
}

/**
 * EN-183, EN-188. After the discharge the attention keeps a principal: the
 * RDACAA reads the cause of the consultation from it, and nobody fixes it at
 * the signature any more. The way out is EN-183's: mark another one as
 * principal — the old one moves behind — and then unmark or remove this one.
 * Nothing is promoted on its own: which diagnosis is the cause is the
 * doctor's to say.
 */
export class DiagnosisPrimaryRequiredAfterDischargeError extends ConflictError {
  readonly code = 'DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE';
  override readonly userTitle =
    'La atención ya tiene el alta y necesita un diagnóstico principal: marque otro como principal antes de quitar o desmarcar éste';

  constructor() {
    super('A discharged encounter keeps a principal diagnosis');
  }
}

/**
 * EN-213. «Deshacer» a removal that was already undone, or whose code was
 * recorded again meanwhile: bringing it back would leave the same diagnosis
 * twice. The list on screen is stale.
 */
export class DiagnosisNotRestorableError extends ConflictError {
  readonly code = 'DIAGNOSIS_NOT_RESTORABLE';
  override readonly userTitle =
    'Ese diagnóstico ya se recuperó o se volvió a registrar. Actualice la lista';

  constructor() {
    super('The removed diagnosis was already restored or recorded again');
  }
}

/**
 * EN-212 (D-127, D-117.14). Changing the CODE of a diagnosis that a paper in
 * a third party's hands printed — an issued certificate (EN-189) or an issued
 * receta (PR-026), in force or annulled — states why: the paper does not
 * change, and the history has to explain why it says something else. Chosen
 * from a list on the screen (D-126.3); demanded here and by
 * `trg_encounter_diagnosis_edit_admits`.
 */
export class DiagnosisEditReasonRequiredError extends ValidationError {
  readonly code = 'DIAGNOSIS_EDIT_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué cambia el código: un certificado, una receta o una orden ya entregados lo imprimieron';
  override readonly fieldErrors = [
    {
      field: 'reason',
      code: 'DIAGNOSIS_EDIT_REASON_REQUIRED',
      message: 'Elija por qué cambia el código',
    },
  ];

  constructor() {
    super('Diagnosis code change without a reason while a paper printed it');
  }
}

/**
 * EN-212, D-117.13. After the discharge the coding that goes to the RDACAA is
 * corrected by whoever may sign the history at the attention's site
 * (`record:sign`), as the amendment of the note is. Before it, whoever codes.
 * A 403 and not a 422: nothing in the request is wrong, the caller is.
 */
export class DiagnosisCorrectionRequiresSignatureError extends ForbiddenError {
  readonly code = 'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE';
  override readonly userTitle =
    'La atención ya tiene el alta: corrige sus diagnósticos quien firma historia clínica en esta sede';

  constructor() {
    super('Correcting the coding after the discharge requires record:sign');
  }
}

/**
 * EN-228, D-134.3. After the discharge the taking is corrected by whoever may
 * sign the history at the attention's site (`record:sign`): the 002 is signed
 * and carries those figures, as the coding of block K does (D-117.13). Before
 * it, `vitals:write` is enough. A 403: the caller is what is wrong.
 */
export class VitalsCorrectionRequiresSignatureError extends ForbiddenError {
  readonly code = 'VITALS_CORRECTION_REQUIRES_SIGNATURE';
  override readonly userTitle =
    'La atención ya tiene el alta: corrige sus signos vitales quien firma historia clínica en esta sede';

  constructor() {
    super(
      'Correcting the vital signs after the discharge requires record:sign',
    );
  }
}

/**
 * EN-212, EN-213, D-117.15. A maternity rest of the attention that is not
 * annulled stands on an obstetric diagnosis (CER-049): taking the last one
 * away — or recoding it outside the chapter — would leave an IESS paper with
 * nothing under it. The way out is to annul the rest.
 */
export class DiagnosisSupportsMaternityRestError extends ConflictError {
  readonly code = 'DIAGNOSIS_SUPPORTS_MATERNITY_REST';
  override readonly userTitle =
    'Este diagnóstico sostiene el reposo de maternidad emitido en la atención: anule primero el reposo y después corrija';

  constructor() {
    super('The obstetric diagnosis supports a maternity rest in force');
  }
}

/**
 * EN-212, EN-213, D-117.16. The attention was already reported to the RDACAA
 * (`reported_at`, EN-111), and nothing resends it: a correction would leave
 * the ministry with the old coding and the chart with another. Refused until
 * the resend exists.
 */
export class EncounterAlreadyReportedError extends ConflictError {
  readonly code = 'ENCOUNTER_ALREADY_REPORTED';
  override readonly userTitle =
    'Esta atención ya se reportó al RDACAA y la corrección no llegaría al Ministerio. Pida a administración que gestione la corrección del envío';

  constructor() {
    super('The encounter was already reported to the RDACAA');
  }
}

/**
 * EN-200. Somebody published a newer version of this template while the
 * screen was editing an older one. Publishing anyway would silently drop
 * their changes, so the second publication is refused and the screen reloads
 * what is current.
 */
export class NoteTemplateStaleError extends ConflictError {
  readonly code = 'NOTE_TEMPLATE_STALE';
  override readonly userTitle =
    'Otra persona publicó esta plantilla mientras la editaba. Recargue para ver la versión actual';

  constructor(expected: number, current: number) {
    super(`Note template is at version ${current}, not ${expected}`, {
      expected: String(expected),
      current: String(current),
    });
  }
}
