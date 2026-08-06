import type { DomainFieldError } from '../domain/errors/domain-error';

/**
 * Turns Zod issues into RFC 9457 field errors.
 *
 * Without this, a validation failure reaches the client as a bare
 * `400 BAD_REQUEST` with no indication of which field is wrong — even though
 * Zod knew exactly what failed and why. The client is then unable to highlight
 * the offending input, and the user is left guessing.
 */

/** Shape of a Zod issue. Declared locally so this file does not depend on Zod. */
interface ZodIssueLike {
  code?: string;
  path?: PropertyKey[];
  message?: string;
}

export interface ZodErrorLike {
  issues?: ZodIssueLike[];
}

/**
 * Zod's issue codes mapped to STABLE codes.
 *
 * Zod is free to rename its internal codes between majors — it already did
 * between v3 and v4. Mapping here means our public contract does not move when
 * a dependency does.
 */
const CODE_BY_ZOD_ISSUE: Readonly<Record<string, string>> = {
  invalid_type: 'INVALID_TYPE',
  invalid_format: 'INVALID_FORMAT',
  invalid_string: 'INVALID_FORMAT',
  too_small: 'TOO_SMALL',
  too_big: 'TOO_BIG',
  invalid_value: 'INVALID_VALUE',
  invalid_enum_value: 'INVALID_VALUE',
  unrecognized_keys: 'UNKNOWN_FIELD',
  invalid_union: 'INVALID_VALUE',
  not_multiple_of: 'INVALID_VALUE',
  custom: 'INVALID_VALUE',
};

/** Dot notation, with array indices in brackets: `items[0].quantity`. */
function toFieldPath(path: PropertyKey[] | undefined): string {
  if (!path?.length) return '(root)';

  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc ? `${acc}.${String(segment)}` : String(segment);
  }, '');
}

export function zodIssuesToFieldErrors(error: unknown): DomainFieldError[] {
  const issues = (error as ZodErrorLike | undefined)?.issues;
  if (!Array.isArray(issues)) return [];

  return issues.map((issue) => ({
    field: toFieldPath(issue.path),
    code: CODE_BY_ZOD_ISSUE[issue.code ?? ''] ?? 'INVALID_VALUE',
    message: issue.message ?? 'El valor no es válido',
  }));
}

/**
 * Detects a `ZodValidationException` without importing nestjs-zod here.
 *
 * The shared HTTP layer must not depend on a validation library: swapping Zod
 * later should not mean rewriting the error contract.
 */
export function extractZodError(exception: object): ZodErrorLike | undefined {
  const candidate = exception as { getZodError?: () => ZodErrorLike };
  return typeof candidate.getZodError === 'function'
    ? candidate.getZodError()
    : undefined;
}
