import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  QuotaExceededError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';

import {
  AssistantNotConfiguredError,
  AssistantSpendingCeilingReachedError,
  LlmCallFailed,
  SuggestionAlreadyDecidedError,
  SuggestionNotFoundError,
} from './assistant.errors';

/**
 * The error contract: stable code, the category that decides the HTTP status
 * (`problem-details.filter.ts`: a retryable external failure is 503, any other
 * 502; a quota is 429), and a sentence the user can act on.
 */
describe('assistant errors', () => {
  it('AS-006 answers ASSISTANT_NOT_CONFIGURED as a non-retryable external failure', () => {
    const error = new AssistantNotConfiguredError();

    expect(error.code).toBe('ASSISTANT_NOT_CONFIGURED');
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.isRetryable).toBe(false);
    expect(error.userTitle).toMatch(/asistente/i);
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('AS-007 AS-008 answers ASSISTANT_PROVIDER_FAILED, retryable only when no provider could attend', () => {
    const unavailable = new LlmCallFailed('gemini', 'provider-error', {
      model: 'm',
      raw: null,
      status: 503,
    });
    const badAnswer = new LlmCallFailed('gemini', 'invalid-answer', {
      model: 'm',
      raw: '{}',
    });

    for (const error of [unavailable, badAnswer]) {
      expect(error.code).toBe('ASSISTANT_PROVIDER_FAILED');
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect(error.userTitle).toMatch(/asistente/i);
    }
    expect(unavailable.isRetryable).toBe(true);
    expect(badAnswer.isRetryable).toBe(false);
    expect(DOMAIN_ERROR_CODES).toContain('ASSISTANT_PROVIDER_FAILED');
  });

  it('AS-017 answers ASSISTANT_SPENDING_CEILING_REACHED as a quota', () => {
    const error = new AssistantSpendingCeilingReachedError();

    expect(error.code).toBe('ASSISTANT_SPENDING_CEILING_REACHED');
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.userTitle).toMatch(/gasto/i);
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('AS-023 answers SUGGESTION_ALREADY_DECIDED as a conflict', () => {
    const error = new SuggestionAlreadyDecidedError();

    expect(error.code).toBe('SUGGESTION_ALREADY_DECIDED');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Esta propuesta ya se aceptó o se descartó. Recargue para ver lo que quedó',
    );
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('AS-023 answers SUGGESTION_NOT_FOUND as a 404 that says what to do', () => {
    const error = new SuggestionNotFoundError();

    expect(error.code).toBe('SUGGESTION_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.userTitle).toBe(
      'No se encontró la propuesta del asistente. Recargue la atención',
    );
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
  });

  it('AS-019 never puts the text of the call in a message', () => {
    const prompt = 'Paciente refiere dolor torácico desde ayer';
    const error = new LlmCallFailed('gemini', 'invalid-answer', {
      model: 'm',
      raw: prompt,
    });

    expect(error.message).not.toContain(prompt);
    expect(error.userTitle).not.toContain(prompt);
    expect(JSON.stringify(error.params)).not.toContain(prompt);
    // The raw answer stays reachable for the exchange log, but no serializer sees it.
    expect(error.received.raw).toBe(prompt);
    expect(Object.keys(error)).not.toContain('received');
    expect(JSON.stringify(error)).not.toContain(prompt);
  });
});
