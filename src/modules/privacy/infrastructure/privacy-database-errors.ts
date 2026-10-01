/**
 * The two ways PostgreSQL refuses a consent text publication that lost a race
 * (PD-005), translated to the code the SPEC fixes.
 *
 *   - `consent_text_version_number_unique` (23505): both transactions computed
 *     the same next number and the second one waited for the first to commit.
 *   - `consent_text_version_is_next` (23514): the first one committed BEFORE
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
  ['23505', 'consent_text_version_number_unique'],
  ['23514', 'consent_text_version_is_next'],
]);

/** Whether `error` is PostgreSQL refusing a publication that lost PD-005's race. */
export function isConsentTextRace(error: unknown): boolean {
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
