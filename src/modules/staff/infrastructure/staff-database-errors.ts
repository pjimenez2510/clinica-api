/**
 * Reads what PostgreSQL refused, so the repository can throw the domain error
 * whose code the SPEC fixes.
 *
 * SAME SHAPE AS `specialties-database-errors.ts` AND `organization-…`, AND NOT
 * SHARED WITH THEM. The duplication is two small predicates; sharing them
 * would put a file in `shared/` that three modules must agree on before
 * changing, and the only part that matters — which refusal means what HERE —
 * has nothing in common between the three. See that file for why the shared
 * `constraint-meanings` registry cannot do this job: it upgrades the CODE of a
 * response, but the STATUS still comes from the SQLSTATE, and a foreign-key
 * violation is 422 there — right for "you referenced a row that does not
 * exist", wrong for "you deleted a row that is referenced", which ST-010 fixes
 * at 409.
 *
 * PHI WARNING, same as `database-problem.ts`: the offending row rides in the
 * driver's `detail`, and for this module that row carries a cedula. Only the
 * SQLSTATE and the constraint NAME are ever read here; every message thrown is
 * written by hand in the domain error classes.
 */

/** Shape of a Prisma error. Local so this file does not import Prisma. */
interface PrismaErrorLike {
  code?: unknown;
  clientVersion?: unknown;
  meta?: {
    driverAdapterError?: {
      cause?: {
        code?: unknown;
        originalCode?: unknown;
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

function sqlStateOf(error: PrismaErrorLike): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  const raw = cause?.code ?? cause?.originalCode;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * What a refused DELETE looks like from Prisma 7 over the PG driver adapter:
 * a `P2039` whose `meta` is EMPTY and whose message carries the SQLSTATE and
 * the constraint. Anchored on PostgreSQL's own wording.
 */
const RESTRICTED_DELETE =
  /violates (?:RESTRICT setting of )?foreign key constraint/;

/**
 * Whether a DELETE was refused because rows still reference the practitioner
 * (`ON DELETE RESTRICT`: SQLSTATE 23001, or 23503 for a plain FK). ST-010 is
 * exactly this: appointments, encounters, prescriptions and signed documents
 * all point here with RESTRICT, while the rows that are pure configuration —
 * sites, specialties, duration exceptions, schedule rules — CASCADE, because
 * a practitioner's own settings mean nothing without the practitioner.
 *
 * Only ever called in a delete's catch block: an INSERT's foreign-key failure
 * would match the message too, but no insert path asks.
 */
export function isForeignKeyRestriction(error: unknown): boolean {
  if (!isPrismaError(error)) return false;

  const sqlState = sqlStateOf(error);
  if (sqlState === '23001' || sqlState === '23503') return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && RESTRICTED_DELETE.test(message);
}

/** Prisma's "the row this operation depended on is gone" (update/delete by id). */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}
