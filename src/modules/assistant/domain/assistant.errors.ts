import {
  ExternalServiceError,
  QuotaExceededError,
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
