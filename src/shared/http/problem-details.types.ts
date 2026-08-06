/**
 * RFC 9457 — Problem Details for HTTP APIs.
 * Proposed Standard, July 2023. Obsoletes RFC 7807.
 *
 * Served with `Content-Type: application/problem+json`.
 */

/** Standard members from RFC 9457 section 3.1. */
export interface ProblemDetailsBase {
  /**
   * URI identifying the problem TYPE.
   * Section 3.1.1 clarifies it does NOT need to be dereferenceable: no
   * documentation has to be served at that URL for the contract to be valid.
   */
  type: string;
  /** Human readable summary of the problem type. Translated. */
  title: string;
  status: number;
  /** Explanation of THIS occurrence. Translated. NEVER carries health data. */
  detail?: string;
  /** URI of the specific occurrence. No query string: it may carry a cedula. */
  instance?: string;
}

/**
 * Custom extensions. Section 3.2 requires clients to ignore members they do
 * not recognise, so adding these is standard compliant.
 */
export interface ProblemDetails extends ProblemDetailsBase {
  /**
   * STABLE business code, English and uppercase.
   * This is the machine contract: clients switch on it and integrators use it
   * in their alerts. Never translated, never renamed.
   */
  code: string;
  /** OpenTelemetry trace id: the user reports the id and you find the trace. */
  traceId?: string;
  timestamp: string;
  /** Per-field errors, for forms. */
  errors?: FieldError[];
  /**
   * Names of the failing dependencies on a readiness failure (503).
   * Names only (`database`), never the error message: that one can carry the
   * connection string with credentials.
   */
  failedDependencies?: string[];
}

export interface FieldError {
  /** Field path in dot notation: `patient.cedula`. */
  field: string;
  /** Stable code, not translated. */
  code: string;
  /** Translated message shown to the user. */
  message: string;
  /**
   * Rejected value. OMITTED when the field may contain personal data:
   * returning the rejected cedula in the response body is a leak.
   */
  rejectedValue?: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
