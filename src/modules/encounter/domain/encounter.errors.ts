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

/**
 * EN-063. Anthropometry that the instructivo makes obligatory is missing.
 *
 * Literal from the note to block D (instructivo, p. 44): *«los datos
 * antropométricos con \* es obligatorio para usuarios menores de 5 años o que
 * corresponda al grupo prioritario "Embarazadas"»*.
 *
 * ⚠️ ONLY THE AGE HALF IS ENFORCED TODAY, and the reason is written on the
 * requirement rather than hidden here: the pregnancy half reads
 * `encounter_priority_group`, whose catalogue does not exist yet (EN-099). The
 * age used is the FROZEN one of EN-008 — what was true that day — never
 * today's, which is what keeps a report reprocessed next year identical.
 *
 * THE MISSING FIELDS ARE NAMED ONE BY ONE: «faltan datos» sends a nurse round
 * a form where three boxes could be the one.
 */
export class VitalsRequiredError extends ValidationError {
  readonly code = 'VITALS_REQUIRED';
  override readonly userTitle =
    'En menores de 5 años el peso, la talla y el perímetro cefálico son obligatorios';

  constructor(missing: readonly string[]) {
    super(
      `Mandatory anthropometry missing for a patient under five: ${missing.join(', ')}`,
      { missing: missing.join(',') },
      missing.map((field) => ({
        field,
        code: 'VITALS_REQUIRED',
        message: 'Obligatorio en menores de 5 años',
      })),
    );
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

  constructor(missing: readonly string[]) {
    super(
      `Form is missing mandatory sections: ${missing.join(', ')}`,
      { missing: missing.join(',') },
      missing.map((section) => ({
        field: `content.${section}`,
        code: 'NOTE_CONTENT_INCOMPLETE',
        message: 'Sección obligatoria del formulario',
      })),
    );
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
 * EN-166 (D-077). An attention annulled without a written reason.
 *
 * Demanded in the service and not only in the DTO: «esta atención no debió
 * existir» without a reason is a door for making a consultation disappear,
 * and the database refuses it a third time
 * (`encounter_entered_in_error_states_who_why_when`).
 */
export class EncounterAnnulmentReasonRequiredError extends ValidationError {
  readonly code = 'ENCOUNTER_ANNULMENT_REASON_REQUIRED';
  override readonly userTitle =
    'Indique por qué anula la atención. Queda escrito con su nombre y la hora, y lo escrito en ella no se borra';
  override readonly fieldErrors = [
    {
      field: 'reason',
      code: 'ENCOUNTER_ANNULMENT_REASON_REQUIRED',
      message: 'Indique el motivo de la anulación',
    },
  ];

  constructor() {
    super('Encounter annulment requested without a reason');
  }
}

/** EN-166, D-099 §1. How many of each act still stands in the attention. */
export interface LiveActs {
  prescriptions: number;
  orders: number;
  signedNotes: number;
  certificates: number;
  referrals: number;
  interconsultations: number;
}

/**
 * EN-166, D-099 §1. The attention already left something in the chart —a
 * prescription active or in draft, an order still pending, a signed note, a
 * certificate not revoked, a referral or an interconsultation in force— and it
 * is retracted by its own door before the attention is annulled.
 */
export class EncounterHasLiveActsError extends ConflictError {
  readonly code = 'ENCOUNTER_HAS_LIVE_ACTS';
  override readonly userTitle: string;

  constructor(acts: LiveActs) {
    // Counts only: no patient, no drug, no exam reaches a log.
    super('Encounter holds acts that have to be retracted first', { ...acts });
    const parts = [
      acts.prescriptions > 0
        ? `${acts.prescriptions} receta(s) activa(s) o en borrador`
        : null,
      acts.orders > 0 ? `${acts.orders} orden(es) pendiente(s)` : null,
      acts.signedNotes > 0 ? `${acts.signedNotes} nota(s) firmada(s)` : null,
      acts.certificates > 0
        ? `${acts.certificates} certificado(s) sin revocar`
        : null,
      acts.referrals > 0 ? `${acts.referrals} referencia(s) vigente(s)` : null,
      acts.interconsultations > 0
        ? `${acts.interconsultations} interconsulta(s) pendiente(s)`
        : null,
    ].filter(Boolean);
    this.userTitle = `La atención tiene ${parts.join(', ')}. Anúlelas o retráctelas antes de anular la atención`;
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
 */
export class EncounterHasOthersDraftsError extends ConflictError {
  readonly code = 'ENCOUNTER_HAS_OTHERS_DRAFTS';
  override readonly userTitle =
    'La atención tiene una nota en borrador de otra persona. Que la firme o la descarte antes de interrumpir';

  constructor() {
    super('Encounter holds a draft note of another author');
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
    'Esa alergia ya estaba descartada, con su fecha y su motivo. Si hay algo nuevo que decir, regístrela otra vez';

  constructor() {
    super('Allergy has already been refuted');
  }
}

/**
 * EN-082. An allergy was ruled out without saying why.
 *
 * DEMANDED IN THE SERVICE AND NOT ONLY IN THE DTO, for the same reason
 * `AMENDMENT_REASON_REQUIRED` is: the DTO guards ONE door. An import, a
 * console and a use case somebody writes in two years all reach the service,
 * and a refutation with no reason is a row that says an allergy was ruled out
 * by nobody knows what evidence — which is exactly the row a future doctor has
 * to decide whether to trust.
 *
 * 422 with the field named: the request is wrong and the way out is to write
 * the reason.
 */
export class RefutationReasonRequiredError extends ValidationError {
  readonly code = 'REFUTATION_REASON_REQUIRED';
  override readonly userTitle: string;
  override readonly fieldErrors: {
    field: string;
    code: string;
    message: string;
  }[];

  /**
   * The same rule for an allergy and for a history entry (EN-085), so ONE
   * code; the sentence names which of the two, because «descarta la alergia»
   * read over a family history is a screen that does not know what it holds.
   */
  constructor(subject: 'la alergia' | 'el antecedente' = 'la alergia') {
    super('Refuting requires a written reason');
    const noun = subject === 'la alergia' ? 'esta alergia' : 'este antecedente';
    this.userTitle = `Escriba por qué se descarta ${subject}: quien lo lea dentro de dos años necesita saberlo`;
    this.fieldErrors = [
      {
        field: 'notes',
        code: 'REFUTATION_REASON_REQUIRED',
        message: `Indique por qué se descarta ${noun}`,
      },
    ];
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
    'Ese antecedente ya estaba descartado, con su fecha y su motivo. Si hay algo nuevo que decir, regístrelo otra vez';

  constructor() {
    super('History entry has already been refuted');
  }
}

/**
 * EN-087. «Sin alergias conocidas» over a chart that has allergies on it.
 *
 * ⚠️ REFUSED AND NOT MERGED INTO A WARNING. The two statements cannot both be
 * on one chart: whoever reads «sin alergias conocidas» stops reading the list,
 * which is the whole reason the band says it at all. What the caller has to do
 * is refute the allergies that are no longer valid ONE BY ONE, each with its
 * reason (EN-082) — and that is a clinical judgement per allergy, never a side
 * effect of ticking a box.
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
    'Esta ficha tiene alergias registradas. Descarte primero las que ya no sean válidas, con su motivo, antes de afirmar que no hay ninguna';

  constructor() {
    super('Cannot assert no known allergies on a chart with active allergies');
  }
}
