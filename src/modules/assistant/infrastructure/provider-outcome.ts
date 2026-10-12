import type { LlmFailure } from '../domain/llm-outcome';

/**
 * AS-004. What an HTTP status means for the chain, the same for every
 * adapter.
 *
 * `401/403/404` belong to this installation's account with the provider (key,
 * plan, model) and not to the request: they are a provider that cannot attend,
 * so the next one is asked. A `400` is the request itself, and would fail the
 * same anywhere.
 */
export function outcomeOfStatus(status: number): LlmFailure {
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status >= 500 || status === 401 || status === 403 || status === 404) {
    return 'provider-error';
  }
  return 'refused';
}

/**
 * AS-007, AS-009. Why the signal of an attempt fired: the routing's deadline
 * (named `TimeoutError`, as `AbortSignal.timeout` names it) or a caller that
 * no longer wants the answer.
 */
export function abortOutcome(signal: AbortSignal): 'timeout' | 'cancelled' {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'cancelled';
}

/** A network failure, unless the signal says it was a deadline or a cancel. */
export function outcomeOfThrown(
  cause: unknown,
  signal: AbortSignal | undefined,
): 'timeout' | 'cancelled' | 'provider-error' {
  if (signal?.aborted) return abortOutcome(signal);
  return cause instanceof Error && cause.name === 'TimeoutError'
    ? 'timeout'
    : 'provider-error';
}

/**
 * AS-017 (D-241 §9). Network errors that happen BEFORE the request is sent:
 * nothing reached the provider, so nothing was billed. Any other network error
 * — a reset, a socket that hung up — may come after the provider started.
 */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Whether a thrown network error, or one it wraps, is one of NEVER_SENT_CODES. */
export function neverSent(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
