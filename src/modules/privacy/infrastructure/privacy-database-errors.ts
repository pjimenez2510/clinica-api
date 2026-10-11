/**
 * The two ways PostgreSQL refuses a privacy notice publication that lost a
 * race (PD-005), translated to the code the SPEC fixes.
 *
 *   - `privacy_notice_version_number_unique` (23505): both transactions
 *     computed the same next number and the second one waited for the first.
 *   - `privacy_notice_version_is_next` (23514): the first one committed BEFORE
 *     the second one's trigger read the maximum, so the number it carries is
 *     no longer the next.
 *
 * Same reading of the driver adapter's error as the other modules'
 * `*-database-errors.ts`: the SQLSTATE and the constraint name, never the
 * message text alone.
 */
interface PrismaErrorLike {
  code?: unknown;
  clientVersion?: unknown;
  meta?: {
    driverAdapterError?: {
      cause?: {
        code?: unknown;
        originalCode?: unknown;
        originalMessage?: unknown;
        constraint?: { index?: unknown };
      };
    };
  };
}

function isPrismaError(exception: unknown): exception is PrismaErrorLike {
  if (typeof exception !== 'object' || exception === null) return false;
  const candidate = exception as PrismaErrorLike;
  return (
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code) &&
    typeof candidate.clientVersion === 'string'
  );
}

const LOST_RACE = new Map([
  ['23505', 'privacy_notice_version_number_unique'],
  ['23514', 'privacy_notice_version_is_next'],
]);

/** Whether `error` is PostgreSQL refusing a publication that lost PD-005's race. */
export function isPrivacyNoticeRace(error: unknown): boolean {
  if (!isPrismaError(error)) return false;
  const cause = error.meta?.driverAdapterError?.cause;
  const sqlState = cause?.code ?? cause?.originalCode;
  if (typeof sqlState !== 'string') return false;
  const expected = LOST_RACE.get(sqlState);
  if (!expected) return false;

  const index = cause?.constraint?.index;
  const message = cause?.originalMessage;
  return (
    index === expected ||
    (typeof message === 'string' && message.includes(expected))
  );
}

/** One SQLSTATE and one constraint, read the same way as above. */
function refusedBy(
  error: unknown,
  sqlState: string,
  constraint: string,
): boolean {
  if (!isPrismaError(error)) return false;
  const cause = error.meta?.driverAdapterError?.cause;
  const code = cause?.code ?? cause?.originalCode;
  if (code !== sqlState) return false;
  const index = cause?.constraint?.index;
  const message = cause?.originalMessage;
  return (
    index === constraint ||
    (typeof message === 'string' && message.includes(constraint))
  );
}

/**
 * PD-071. The base refusing a second standing authorization with the same
 * purpose and channel (`patient_authorization_one_standing`, 23505).
 */
export function isSecondStandingAuthorization(error: unknown): boolean {
  return refusedBy(error, '23505', 'patient_authorization_one_standing');
}

/**
 * PD-072. Two revocations of the same authorization at once: its key lets
 * one through (`patient_authorization_revocation_pkey`, 23505).
 */
export function isAuthorizationRevocationRace(error: unknown): boolean {
  return refusedBy(error, '23505', 'patient_authorization_revocation_pkey');
}
