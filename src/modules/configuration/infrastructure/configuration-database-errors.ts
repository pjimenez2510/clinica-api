import type { DomainError } from '../../../shared/domain/errors/domain-error';
import { HolidayDuplicateError } from '../domain/configuration.errors';

/**
 * Reads which configuration constraint PostgreSQL raised, so the repository
 * can throw the domain error whose code the SPEC fixes.
 *
 * SAME SHAPE AS `organization-database-errors.ts`, AND NOT SHARED WITH IT. The
 * duplication is three small functions; sharing them would put a file in
 * `shared/` that every module has to agree on before changing, and the list of
 * constraint names — the only part that matters — has nothing in common. See
 * that file for why the shared `constraint-meanings` registry cannot do this
 * job on its own: it upgrades the CODE of a response, but the STATUS still
 * comes from the SQLSTATE.
 *
 * PHI WARNING, same as `database-problem.ts`: the offending row rides in the
 * driver's `detail`. Only the CONSTRAINT NAME is read here, and every message
 * thrown is written by hand in the domain error classes.
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
        originalMessage?: unknown;
        constraint?: { index?: unknown; fields?: unknown };
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
 * The constraint that fired. Prisma is inconsistent about where it puts the
 * name — a unique index arrives in `constraint.index`, a check only inside the
 * original message — so both places are read, anchored on the exact wording
 * PostgreSQL uses so nothing else in the message can pose as a constraint name.
 */
function constraintNameOf(error: PrismaErrorLike): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  if (!cause) return undefined;

  const index = cause.constraint?.index;
  if (typeof index === 'string') return index;

  const message = cause.originalMessage;
  if (typeof message !== 'string') return undefined;
  return /violates (?:unique|check|exclusion|foreign key) constraint "([^"]+)"/.exec(
    message,
  )?.[1];
}

/**
 * The unique index of this module, mapped to the domain error whose code the
 * SPEC fixes (CF-061).
 *
 * ONE ENTRY, and it covers BOTH scopes: `holiday_date_scope_unique` is
 * `NULLS NOT DISTINCT`, so the same index refuses «1 de enero en la sede X»
 * twice and «1 de enero en todas las sedes» twice. Two partial indexes would
 * have meant two names here and a client that has to tell them apart for no
 * reason.
 */
const DUPLICATE_BY_CONSTRAINT: Record<string, () => DomainError> = {
  holiday_date_scope_unique: () => new HolidayDuplicateError(),
};

/**
 * The domain error for a unique violation of THIS module, or `undefined` when
 * the failure is somebody else's and must keep travelling untouched.
 */
export function duplicateErrorFrom(error: unknown): DomainError | undefined {
  if (!isPrismaError(error)) return undefined;
  if (sqlStateOf(error) !== '23505') return undefined;

  const constraint = constraintNameOf(error);
  return constraint ? DUPLICATE_BY_CONSTRAINT[constraint]?.() : undefined;
}

/** Prisma's "the row this operation depended on is gone" (update/delete by id). */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}
