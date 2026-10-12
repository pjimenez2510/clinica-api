import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

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
