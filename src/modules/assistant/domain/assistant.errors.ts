import {
  ConflictError,
  type DomainFieldError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import type { UnavailableReason } from './listening';
import {
  isAvailabilityFailure,
  type LlmFailure,
  type ProviderName,
  type TokenUsage,
} from './llm-outcome';

/**
 * AS-006. No provider is in the chain: the remote switch is off, or no
 * provider has its key. Retrying changes nothing until the installation is
 * configured, so it is not retryable.
 */
export class AssistantNotConfiguredError extends ExternalServiceError {
  readonly code = 'ASSISTANT_NOT_CONFIGURED';
  readonly service = 'llm';
  readonly isRetryable = false;
  override readonly userTitle =
    'El asistente no tiene un proveedor configurado en esta instalación. Puede seguir escribiendo como siempre';

  constructor() {
    super('No language model provider is configured or allowed');
  }
}

/**
 * AS-020. A proposal whose sources are not a list of known places (a stretch
 * of the conversation, or a datum of the chart in a known table), or an
 * acceptance with nothing saved to compare it with.
 */
export class SuggestionInvalidError extends ValidationError {
  readonly code = 'SUGGESTION_INVALID';
  override readonly userTitle =
    'La propuesta del asistente no se pudo guardar. Vuelva a pedirla';

  constructor(reason: string) {
    super(`Invalid suggestion: ${reason}`);
  }
}

/** AS-023. The proposal does not exist, or is of an attention out of scope. */
export class SuggestionNotFoundError extends NotFoundError {
  readonly code = 'SUGGESTION_NOT_FOUND';
  override readonly userTitle =
    'No se encontró la propuesta del asistente. Recargue la atención';

  constructor() {
    super('Suggestion not found');
  }
}

/**
 * AS-023. The proposal was already accepted or discarded: a decision is
 * final, and what the doctor did with it is the trace of P1.
 */
export class SuggestionAlreadyDecidedError extends ConflictError {
  readonly code = 'SUGGESTION_ALREADY_DECIDED';
  override readonly userTitle =
    'Esta propuesta ya se aceptó o se descartó. Recargue para ver lo que quedó';

  constructor() {
    super('The suggestion was already decided');
  }
}

/**
 * AS-017. The month's ceiling does not admit the attempt, or there is no
 * ceiling at all. A quota of the installation, not a fault of the provider.
 */
export class AssistantSpendingCeilingReachedError extends QuotaExceededError {
  readonly code = 'ASSISTANT_SPENDING_CEILING_REACHED';
  override readonly userTitle =
    'El asistente alcanzó el límite de gasto de este mes. Puede seguir escribiendo como siempre';

  constructor() {
    super(
      'The monthly spending ceiling of the assistant does not admit this call',
    );
  }
}

/**
 * What the provider sent back on a failed attempt, kept for `ai_run` (the
 * figures) and for `ai_exchange` (the raw text, only when the exchange log is
 * on). Never part of the message.
 */
export interface FailedAttempt extends Partial<TokenUsage> {
  model: string;
  raw: string | null;
  status?: number;
  /**
   * AS-017 (D-241 §9). The request never reached the provider: the connection
   * was refused, the name did not resolve, TLS failed. Only then does a
   * failure without a status count 0; a connection cut after sending may have
   * been billed.
   */
  neverSent?: boolean;
}

/**
 * AS-004, AS-007, AS-008, AS-019. An attempt that produced no usable answer.
 *
 * BESIDE THE PORT'S VOCABULARY, NOT IN AN ADAPTER: every adapter throws it and
 * the routing branches on `outcome`. It is retryable exactly when the failure
 * is one of availability: that is also what passes the request to the next
 * provider, so the last one standing tells the caller whether trying again
 * later can help.
 *
 * The technical message names the provider, the outcome and the status, and
 * nothing the provider wrote: an error body can quote the input back, and
 * the input is clinical text (SigmAI A-03).
 */
export class LlmCallFailed extends ExternalServiceError {
  readonly code = 'ASSISTANT_PROVIDER_FAILED';
  readonly service = 'llm';
  readonly isRetryable: boolean;
  override readonly userTitle: string;
  /**
   * What the provider sent back. NOT ENUMERABLE, and left out of `toJSON`:
   * `raw` may hold the answer or an error body that quotes the input, and a
   * `JSON.stringify(error)` or an error tracker must never carry it.
   */
  declare readonly received: FailedAttempt;

  constructor(
    readonly provider: ProviderName,
    readonly outcome: LlmFailure,
    received: FailedAttempt,
  ) {
    super(
      `${provider} attempt ended in ${outcome}${received.status ? ` (HTTP ${received.status})` : ''}`,
      { provider, outcome },
    );
    Object.defineProperty(this, 'received', {
      value: received,
      enumerable: false,
    });
    this.isRetryable = isAvailabilityFailure(outcome);
    this.userTitle = this.isRetryable
      ? 'El asistente no está disponible en este momento. Vuelva a pedirlo en unos minutos o siga escribiendo como siempre'
      : 'El asistente no pudo dar una propuesta válida esta vez. Puede volver a pedirla o seguir escribiendo como siempre';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      outcome: this.outcome,
      message: this.message,
    };
  }
}

/**
 * AS-039, EN-121. The attention does not exist or is of a site the requester
 * cannot reach: one answer for both. Its own code because `encounter`'s
 * belongs to that module, which this one does not import.
 */
export class AssistantEncounterNotFoundError extends NotFoundError {
  readonly code = 'ASSISTANT_ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'Esa atención no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Encounter not found within the caller site scope');
  }
}

/** AS-039 (M-02). Only the attention's own professional asks the assistant. */
export class AssistantNotEncounterOwnerError extends ForbiddenError {
  readonly code = 'ASSISTANT_NOT_ENCOUNTER_OWNER';
  override readonly userTitle =
    'Sólo el profesional de la atención puede pedir y decidir las propuestas del asistente';

  constructor() {
    super('The requester is not the practitioner of the encounter');
  }
}

/** AS-039. The attention no longer takes new clinical content. */
export class AssistantEncounterClosedError extends ConflictError {
  readonly code = 'ASSISTANT_ENCOUNTER_CLOSED';
  override readonly userTitle =
    'La atención ya no admite propuestas nuevas del asistente';

  constructor() {
    super('The encounter does not accept new clinical content');
  }
}

/**
 * AS-165, AS-166 (D-221 §3). The patient has not authorized recording the
 * consultation for the assistant, or revoked it.
 */
export class AssistantRecordingNotAuthorizedError extends ConflictError {
  readonly code = 'ASSISTANT_RECORDING_NOT_AUTHORIZED';
  override readonly userTitle =
    'El paciente no ha autorizado grabar la consulta para el asistente';

  constructor() {
    super('The patient has not authorized recording for the assistant');
  }
}

/**
 * AS-240, AS-244 (B3, revisión). The consultation's listening has begun: what
 * is said from now on is the consultation, which only its professional hears
 * (D-247 §3), never the preparation, which whoever prepares reads.
 */
export class AssistantPreparationOverError extends ConflictError {
  readonly code = 'ASSISTANT_PREPARATION_OVER';
  override readonly userTitle =
    'La consulta ya empezó a escucharse: dicte o escriba los signos';

  constructor() {
    super('The consultation listening of this attention has begun');
  }
}

/** AS-028. There is nothing in the note to read the problems from. */
export class AssistantNoteEmptyError extends ValidationError {
  readonly code = 'ASSISTANT_NOTE_EMPTY';
  override readonly userTitle =
    'La nota todavía no dice nada: escriba la consulta y vuelva a pedir la propuesta';

  constructor() {
    super('The consultation note has no text');
  }
}

/** AS-037. The diagnosis given to accept a proposal is not of its attention. */
export class SuggestionDiagnosisMismatchError extends ValidationError {
  readonly code = 'SUGGESTION_DIAGNOSIS_MISMATCH';
  override readonly userTitle =
    'Ese diagnóstico no está registrado en esta atención. Recargue la atención';

  constructor() {
    super('The diagnosis is not recorded in the encounter of the suggestion');
  }
}

/**
 * AS-265. The record given to accept a proposal of the chart is not of the
 * attention's patient, not of the proposal's class, not recorded by who
 * accepts, or older than the proposal: it is not the proposal's doing.
 */
export class SuggestionChartMismatchError extends ValidationError {
  readonly code = 'SUGGESTION_CHART_MISMATCH';
  override readonly userTitle =
    'Ese registro no es el que propuso el asistente para este paciente. Recargue la atención';

  constructor() {
    super('The chart record does not answer the suggestion');
  }
}

/**
 * AS-036, AS-040. The model answered but its attempt could not be recorded,
 * so the proposal would have no provenance (P2): it is not kept, and asking
 * again may work.
 */
export class AssistantProposalNotKeptError extends ExternalServiceError {
  readonly code = 'ASSISTANT_PROPOSAL_NOT_KEPT';
  readonly service = 'ai_run';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo guardar la propuesta del asistente. Vuelva a pedirla';

  constructor() {
    super('The attempt that answered could not be recorded');
  }
}

/** AS-033. How a call to the local pseudonymizer ended without a cleared text. */
export type PseudonymizerFailure =
  'unavailable' | 'refused' | 'invalid-answer' | 'cancelled';

/**
 * AS-033, AS-034. `clinica-ai` did not clear the text: it was down or slow
 * (retryable), it refused the request, or it answered outside its contract.
 * Nothing is sent to a provider without it.
 *
 * The message names the outcome and the status and nothing else: what went
 * in is a note before it is pseudonymized, and what came back may hold the map
 * from each placeholder to a real name.
 */
export class PseudonymizerFailedError extends ExternalServiceError {
  readonly code = 'ASSISTANT_PSEUDONYMIZER_FAILED';
  readonly service = 'clinica-ai';
  readonly isRetryable: boolean;
  override readonly userTitle: string;

  constructor(
    readonly outcome: PseudonymizerFailure,
    status?: number,
  ) {
    super(
      `clinica-ai pseudonymization ended in ${outcome}${status ? ` (HTTP ${status})` : ''}`,
      { outcome },
    );
    this.isRetryable = outcome === 'unavailable';
    this.userTitle = this.isRetryable
      ? 'El asistente no está disponible en este momento. Vuelva a pedirlo en unos minutos o siga escribiendo como siempre'
      : 'El asistente no pudo preparar el texto esta vez. Puede seguir escribiendo como siempre';
  }
}

/** AS-040. A reading of this attention is already out: one at a time. */
export class AssistantReadingInProgressError extends ConflictError {
  readonly code = 'ASSISTANT_READING_IN_PROGRESS';
  override readonly userTitle =
    'El asistente ya está leyendo esta nota. Espere su respuesta';

  constructor() {
    super('A reading of this encounter is already in progress');
  }
}

/**
 * AS-070 (P5, SigmAI F-01). The patient's allergies could not be read or
 * compared: no line is said to be free of conflict, nothing is proposed and
 * nothing is confirmed. Retryable: the reader was down, not the patient.
 */
export class AssistantAllergyCheckFailedError extends ExternalServiceError {
  readonly code = 'ASSISTANT_ALLERGY_CHECK_FAILED';
  readonly service = 'patient_allergy';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudieron comprobar las alergias del paciente: el asistente no propone medicamentos sin comprobarlas. Vuelva a intentarlo';

  constructor() {
    super('The allergies of the chart could not be read or compared');
  }
}

/** One proposal named by a refusal: by its id and line, never by its medicine (PR-094). */
function proposalErrors(
  ids: readonly string[],
  code: string,
  message: string,
): DomainFieldError[] {
  return ids.map((id) => ({ field: `suggestions.${id}`, code, message }));
}

/**
 * AS-071, AS-073. A line to confirm is the very substance of an allergy of
 * the chart: it does not reach the draft from the proposal.
 */
export class AssistantAllergyContraindicationError extends ConflictError {
  readonly code = 'ASSISTANT_ALLERGY_CONTRAINDICATION';
  override readonly userTitle =
    'La ficha registra una alergia a un medicamento propuesto: descártelo o escríbalo usted en la receta';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(suggestionIds: readonly string[]) {
    super('A proposed line matches an active allergy of the chart');
    this.fieldErrors = proposalErrors(
      suggestionIds,
      this.code,
      'La ficha registra alergia a este principio activo',
    );
  }
}

/**
 * AS-073. A line to confirm is not of the latest reading, was decided
 * already, has no medicine of the cuadro, is controlled or is already in the
 * receta.
 */
export class AssistantPrescriptionLineNotReadyError extends ValidationError {
  readonly code = 'ASSISTANT_PRESCRIPTION_LINE_NOT_READY';
  override readonly userTitle =
    'Alguna línea propuesta ya no se puede añadir a la receta. Recargue la propuesta';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(suggestionIds: readonly string[]) {
    super('A proposed line cannot go to the prescription');
    this.fieldErrors = proposalErrors(
      suggestionIds,
      this.code,
      'Esta línea no se puede añadir a la receta',
    );
  }
}

/**
 * AS-074. The receta given to link a proposal is not of its attention, was
 * discarded, or has no such line.
 */
export class SuggestionPrescriptionMismatchError extends ValidationError {
  readonly code = 'SUGGESTION_PRESCRIPTION_MISMATCH';
  override readonly userTitle =
    'Esa receta no es de esta atención o no tiene esa línea. Recargue la atención';

  constructor() {
    super('The prescription line is not of the encounter of the suggestion');
  }
}

/**
 * AS-109. The order the proposal is linked to is not of its attention, is
 * discarded, has no live line of that exam, or the exam is not one of the
 * proposal's candidates.
 */
export class SuggestionOrderMismatchError extends ValidationError {
  readonly code = 'SUGGESTION_ORDER_MISMATCH';
  override readonly userTitle =
    'Esa orden no es de esta atención o no tiene ese examen. Recargue la atención';

  constructor() {
    super('The order line is not of the encounter or of the suggestion');
  }
}

const UNAVAILABLE_TITLES: Record<UnavailableReason, string> = {
  'no-recognizer':
    'El reconocimiento de voz no está instalado en este equipo. La consulta sigue sin escucha',
  'no-voice-detection':
    'Falta el detector de voz del reconocimiento: sin él se escribirían frases que nadie dijo. La consulta sigue sin escucha',
  unreachable:
    'El reconocimiento de voz no responde. Vuelva a intentarlo en unos minutos o siga sin escucha',
};

/**
 * AS-048. `clinica-ai` cannot listen: it is not installed, it has no voice
 * detector (whisper would write sentences nobody said), or it does not
 * answer. Nothing is opened.
 */
export class ListeningUnavailableError extends ExternalServiceError {
  readonly code = 'ASSISTANT_LISTENING_UNAVAILABLE';
  readonly service = 'clinica-ai';
  readonly isRetryable: boolean;
  override readonly userTitle: string;

  constructor(readonly reason: UnavailableReason) {
    super(`clinica-ai cannot listen: ${reason}`, { reason });
    this.isRetryable = reason === 'unreachable';
    this.userTitle = UNAVAILABLE_TITLES[reason];
  }
}

/** AS-049. A pause, or a frame, on a channel that is not listening. */
export class ListeningNotOpenError extends ConflictError {
  readonly code = 'ASSISTANT_LISTENING_NOT_OPEN';
  override readonly userTitle =
    'La escucha no está abierta en esta pantalla. Pulse «Escuchar»';

  constructor() {
    super('No listening is open on this channel');
  }
}

/**
 * AS-058. A command of the listening failed for a reason that is not the
 * physician's to know (the database, a bug): the screen says it could not,
 * and the log keeps the error's name, never what was said.
 */
export class ListeningFailedError extends ExternalServiceError {
  readonly code = 'ASSISTANT_LISTENING_FAILED';
  readonly service = 'listening';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo usar la escucha. Vuelva a intentarlo';

  constructor() {
    super('A listening command failed');
  }
}

/** AS-086. Nothing was transcribed yet: there is nothing to draft from. */
export class AssistantTranscriptEmptyError extends ValidationError {
  readonly code = 'ASSISTANT_TRANSCRIPT_EMPTY';
  override readonly userTitle =
    'Todavía no hay nada transcrito. Use «Escuchar» y pida el borrador después';

  constructor() {
    super('The attention has no transcript to draft from');
  }
}

/** AS-086, AS-094. The draft is written into the note, which is not open. */
export class AssistantNoteNotOpenError extends ConflictError {
  readonly code = 'ASSISTANT_NOTE_NOT_OPEN';
  override readonly userTitle =
    'La nota no está abierta en borrador. Use «Abrir nota clínica» y vuelva a pedirlo';

  constructor() {
    super('The attention has no consultation note in draft');
  }
}

/** AS-093. The API restarted while the draft was being written. */
export class AssistantDraftInterruptedError extends ExternalServiceError {
  readonly code = 'ASSISTANT_DRAFT_INTERRUPTED';
  readonly service = 'assistant-draft';
  readonly isRetryable = true;
  override readonly userTitle =
    'El borrador se interrumpió al reiniciarse el sistema. Vuelva a pedirlo';

  constructor() {
    super('The draft was interrupted by a restart');
  }
}

/**
 * AS-093. The draft failed for something that is not the physician's to know
 * (the database, a bug): the screen says so and offers «Volver a pedir».
 */
export class AssistantDraftFailedError extends ExternalServiceError {
  readonly code = 'ASSISTANT_DRAFT_FAILED';
  readonly service = 'assistant-draft';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo redactar el borrador. Vuelva a pedirlo';

  constructor() {
    super('The draft could not be written');
  }
}

/**
 * AS-093. «Volver a pedir» on a stretch that already failed three times:
 * each try paid a call. A new stretch, once the transcript grows, starts over.
 */
export class AssistantDraftRetryLimitError extends QuotaExceededError {
  readonly code = 'ASSISTANT_DRAFT_RETRY_LIMIT';
  override readonly userTitle =
    'Este borrador falló tres veces. Siga escribiendo la nota; se volverá a pedir cuando haya más conversación';

  constructor() {
    super('The draft of this stretch failed too many times');
  }
}

/**
 * AS-143, AS-147. The draft was stopped before it finished: the note was
 * signed, or the physician stopped waiting for it. Nothing it returns is kept;
 * it can be asked for again while the note is open.
 */
export class AssistantDraftCancelledError extends ConflictError {
  readonly code = 'ASSISTANT_DRAFT_CANCELLED';
  override readonly userTitle =
    'Se dejó de esperar este borrador. Puede volver a pedirlo mientras la nota siga abierta';

  constructor() {
    super('The draft was cancelled before it finished');
  }
}

/**
 * AS-200. The chart whose history was asked for does not exist or was
 * absorbed by a merge: its history is read from the survivor. Same answer for
 * both, so an identifier that names nothing reveals nothing (PA-024).
 */
export class ClinicalHistoryChartNotOpenError extends ConflictError {
  readonly code = 'CLINICAL_HISTORY_CHART_NOT_OPEN';
  override readonly userTitle =
    'Ese paciente no tiene historia clínica abierta: si se unificó con otra ficha, ábrala desde la ficha que quedó';

  constructor() {
    super('Patient chart does not exist or was absorbed by a merge');
  }
}

/** AS-186. Why a dictation gave no text, as the screen needs to say it. */
export type DictationNotHeard =
  | { kind: 'empty' }
  | { kind: 'unreadable' }
  | { kind: 'silent'; seconds: number };

/** Below this, the button was released before anything was said (SigmAI). */
const TOO_SHORT_S = 1.5;

const SECONDS = new Intl.NumberFormat('es-EC', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function notHeardTitle(heard: DictationNotHeard): string {
  switch (heard.kind) {
    case 'empty':
      return 'No llegó ninguna grabación. Pulse «Dictar», diga los signos y pulse «Terminar»';
    case 'unreadable':
      return 'No se pudo leer la grabación. Vuelva a dictar o escriba los signos';
    case 'silent': {
      const seconds = SECONDS.format(heard.seconds);
      return heard.seconds < TOO_SHORT_S
        ? `Solo llegaron ${seconds} s de grabación. Pulse «Terminar» cuando haya dicho los signos`
        : `Llegaron ${seconds} s de grabación pero no se oyó ninguna voz. Revise que el micrófono sea el correcto y no esté silenciado, o escriba los signos`;
    }
  }
}

/**
 * AS-186. A dictation with nothing to read: no recording, one `clinica-ai`
 * could not decode, or one where it heard no voice. Nothing is filled.
 */
export class DictationNotHeardError extends ValidationError {
  readonly code = 'ASSISTANT_DICTATION_NOT_HEARD';
  override readonly userTitle: string;

  constructor(readonly heard: DictationNotHeard) {
    super(`The dictation was not heard: ${heard.kind}`);
    this.userTitle = notHeardTitle(heard);
  }
}

export type DictationUnavailableReason =
  'no-recognizer' | 'unreachable' | 'busy';

const DICTATION_UNAVAILABLE_TITLES: Record<DictationUnavailableReason, string> =
  {
    'no-recognizer':
      'El reconocimiento de voz no está instalado en este equipo: escriba los signos',
    unreachable:
      'El reconocimiento de voz no responde. Vuelva a intentarlo en unos minutos o escriba los signos',
    busy: 'El reconocimiento de voz está ocupado con otros dictados. Vuelva a intentarlo en unos segundos o escriba los signos',
  };

/**
 * AS-186. `clinica-ai` cannot transcribe: no recogniser, no secret, down, or
 * too slow; or this API already has as many dictations in flight as it lets
 * through (the recogniser is shared with the consultation's listening). Retryable either way: the taking goes on by hand meanwhile.
 */
export class DictationUnavailableError extends ExternalServiceError {
  readonly code = 'ASSISTANT_DICTATION_UNAVAILABLE';
  readonly service = 'clinica-ai';
  readonly isRetryable = true;
  override readonly userTitle: string;

  constructor(readonly reason: DictationUnavailableReason) {
    super(`clinica-ai cannot transcribe the dictation: ${reason}`, { reason });
    this.userTitle = DICTATION_UNAVAILABLE_TITLES[reason];
  }
}

/**
 * AS-310. The recording of a voice arrived without its owner's consent: a
 * voiceprint is biometric data (LOPDP art. 26), and nothing is sent on.
 */
export class VoiceprintConsentRequiredError extends ValidationError {
  readonly code = 'ASSISTANT_VOICEPRINT_CONSENT_REQUIRED';
  override readonly userTitle =
    'Para registrar su voz, marque que consiente que se guarde su huella de voz';

  constructor() {
    super('A voiceprint was sent without consent');
  }
}

/** AS-311. Fewer than ten phrases with voice: the voiceprint would say little. */
export class VoiceNotHeardError extends ValidationError {
  readonly code = 'ASSISTANT_VOICE_NOT_HEARD';
  override readonly userTitle =
    'No se oyó voz suficiente. Lee el texto completo, a la distancia de una consulta.';

  constructor() {
    super('Not enough voice was heard for a voiceprint');
  }
}

/**
 * AS-311, AS-313. `clinica-ai` or its voice model is not there. The reason is
 * `clinica-ai`'s own sentence, never anything of the recording.
 */
export class VoiceUnavailableError extends ExternalServiceError {
  readonly code = 'ASSISTANT_VOICE_UNAVAILABLE';
  readonly service = 'clinica-ai';
  readonly isRetryable = true;
  override readonly userTitle: string;

  constructor(readonly reason: string) {
    super('clinica-ai cannot make a voiceprint');
    this.userTitle = `No se puede registrar la voz ahora: ${reason}`;
  }
}

/** AS-313. «Distinguir mi voz» needs a voice registered first. */
export class VoiceprintMissingError extends ConflictError {
  readonly code = 'ASSISTANT_VOICEPRINT_MISSING';
  override readonly userTitle =
    'Registre su voz en «Mi voz» antes de encender «Distinguir mi voz de la del paciente»';

  constructor() {
    super('No voiceprint is registered');
  }
}

/** AS-317. The line whose speaker is corrected is not in that listening. */
export class TranscriptLineNotFoundError extends NotFoundError {
  readonly code = 'ASSISTANT_TRANSCRIPT_LINE_NOT_FOUND';
  override readonly userTitle =
    'No se encontró esa línea de la transcripción. Recargue la escucha';

  constructor() {
    super('Transcript line not found');
  }
}
