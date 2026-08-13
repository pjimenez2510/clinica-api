import type { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  ServiceTypeDuplicateError,
  SpecialtyDuplicateError,
} from '../domain/specialties.errors';

/**
 * Reads which specialties constraint PostgreSQL raised, so the repository
 * can throw the domain error whose code the SPEC fixes.
 *
 * WHY NOT THE SHARED `constraint-meanings` REGISTRY ALONE. The registry
 * upgrades the CODE of a response but the STATUS still comes from the
 * SQLSTATE class — and a foreign-key violation is 422 there, which is right
 * for "you referenced a row that does not exist" and wrong for "you deleted a
 * row that is referenced": SP-003 and CF-25 demand a 409. The same constraint
 * name means both things depending on the OPERATION, so only the repository,
 * which knows what it was doing, can translate honestly.
 *
 * PHI WARNING, same as `database-problem.ts`: the offending row rides in the
 * driver's `detail`. Only the CONSTRAINT NAME is read here, from where
 * PostgreSQL puts it, and every message thrown is written by hand in the
 * domain error classes.
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

function sqlStateOf(error: PrismaErrorLike): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  const raw = cause?.code ?? cause?.originalCode;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The constraint that fired. Prisma is inconsistent about where it puts the
 * name — a unique index arrives in `constraint.index`, a foreign key only
 * inside the original message — so both places are read, anchored on the
 * exact wording PostgreSQL uses so nothing else in the message can pose as a
 * constraint name.
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
 * The functional unique indexes of this module, each mapped to the domain
 * error whose code SP-006 and SP-026 fix. The migration
 * `20260812222827_configuration_specialties_and_durations` is where these
 * names are born; adding an index there without a line here means the client
 * gets a generic `DUPLICATE_VALUE` instead of the contracted code.
 */
const DUPLICATE_BY_CONSTRAINT: Record<string, () => DomainError> = {
  specialty_code_unique: () => new SpecialtyDuplicateError('code'),
  specialty_name_unique: () => new SpecialtyDuplicateError('name'),
  service_type_name_unique_per_specialty: () => new ServiceTypeDuplicateError(),
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

/**
 * What a refused DELETE looks like from Prisma 7 over the PG driver adapter,
 * captured live (see the integration suite): a `P2039` whose `meta` is EMPTY
 * — no `driverAdapterError` — and whose message carries the SQLSTATE and the
 * constraint: «Database error. Code: `23001`. Message: `update or delete on
 * table "specialty" violates RESTRICT setting of foreign key constraint …`».
 * Anchored on PostgreSQL's own wording, like `database-problem.ts`.
 */
const RESTRICTED_DELETE =
  /violates (?:RESTRICT setting of )?foreign key constraint/;

/**
 * Whether a DELETE was refused because rows still reference the target
 * (`ON DELETE RESTRICT`: SQLSTATE 23001, or 23503 for a plain FK). The
 * caller knows WHICH entity it was deleting, so it — not a name table —
 * picks between `SPECIALTY_IN_USE` and `SERVICE_TYPE_IN_USE` (SP-003,
 * SP-025). Only ever called in a delete's catch block: an INSERT's FK
 * failure would match the message too, but no insert path asks.
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
