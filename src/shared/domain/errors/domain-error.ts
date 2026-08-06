/**
 * A per-field message meant for the end user.
 *
 * Unlike `DomainError.message`, these ARE exposed in the HTTP response in every
 * environment — a validation error that does not say what is wrong is useless.
 * That is exactly why they must never carry the rejected value or any health
 * data: `code` stays stable and English, `message` is what the user reads.
 */
export interface DomainFieldError {
  /** Dot-notation path: `newPassword`, `patient.cedula`. */
  field: string;
  /** Stable machine code. Never translated. */
  code: string;
  /** Text shown to the user. Translated. */
  message: string;
}

/**
 * Root of every business error.
 *
 * ARCHITECTURAL RULE: this layer knows nothing about HTTP. There are no status
 * codes here. The mapping lives in `shared/http/problem-details`, the only
 * place that knows about it. That is what lets the same business rules run
 * from a queue worker or a CLI command, where "404" means nothing.
 */
export abstract class DomainError extends Error {
  /**
   * STABLE business code. It is a public contract: logs, alerts and third-party
   * integrators consume it. Never translated, never renamed.
   */
  abstract readonly code: string;

  /**
   * Parameters for interpolating the translated message.
   * NEVER put health data or national identifiers here: these values end up in
   * the HTTP response and in support screenshots.
   */
  readonly params: Readonly<Record<string, string | number>>;

  /**
   * Field-level detail for the user. Subclasses that reject specific inputs
   * should populate it; without it the client receives a status code and no
   * way to tell the user what to fix.
   */
  readonly fieldErrors?: readonly DomainFieldError[];

  protected constructor(
    technicalMessage: string,
    params: Record<string, string | number> = {},
    fieldErrors?: readonly DomainFieldError[],
  ) {
    // Technical message is English and only feeds logs. Never exposed.
    super(technicalMessage);
    this.name = new.target.name;
    this.params = Object.freeze({ ...params });
    this.fieldErrors = fieldErrors
      ? Object.freeze([...fieldErrors])
      : undefined;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Input violates a domain invariant. */
export abstract class ValidationError extends DomainError {}

/** The resource does not exist, or the caller must not learn that it does. */
export abstract class NotFoundError extends DomainError {}

/** Current state prevents the operation (duplicate, overlap, race). */
export abstract class ConflictError extends DomainError {}

/** Syntactically valid but violates a business rule. */
export abstract class BusinessRuleViolation extends DomainError {}

/** Caller is not authenticated. */
export abstract class UnauthorizedError extends DomainError {}

/** Authenticated, but not allowed on this resource. */
export abstract class ForbiddenError extends DomainError {}

/**
 * A third-party system failed (SRI, IESS, laboratory).
 *
 * `isRetryable` is the distinction that prevents two opposite bugs: retrying a
 * business rejection forever, or discarding a transient network failure.
 */
export abstract class ExternalServiceError extends DomainError {
  abstract readonly service: string;
  abstract readonly isRetryable: boolean;
}
