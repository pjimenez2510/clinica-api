import type { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  EmissionPointDuplicateError,
  SriEstablishmentCodeDuplicateError,
  MspUnicodeDuplicateError,
  SiteRoomDuplicateError,
} from '../domain/organization.errors';

/**
 * Reads which organization constraint PostgreSQL raised, so the repository can
 * throw the domain error whose code the SPEC fixes.
 *
 * SAME SHAPE AS `specialties-database-errors.ts`, AND NOT SHARED WITH IT. The
 * duplication is four small functions; sharing them would put a file in
 * `shared/` that every module has to agree on before changing, and the two
 * lists of constraint names —the only part that matters— have nothing in
 * common. See that file for why the shared `constraint-meanings` registry
 * cannot do this job: it upgrades the CODE of a response, but the STATUS still
 * comes from the SQLSTATE, and a foreign-key violation is 422 there — right
 * for "you referenced a row that does not exist", wrong for "you deleted a row
 * that is referenced", which OR-006 fixes at 409.
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

/**
 * Duck-typed on what every Prisma client error carries — a `P` code of four
 * digits and a `clientVersion` — so this file needs no Prisma import. Anything
 * else is not ours to translate.
 */
function isPrismaError(exception: unknown): exception is PrismaErrorLike {
  if (typeof exception !== 'object' || exception === null) return false;
  const candidate = exception as PrismaErrorLike;
  return (
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code) &&
    typeof candidate.clientVersion === 'string'
  );
}

/**
 * The PostgreSQL SQLSTATE, from wherever the driver adapter put it (`code` or
 * `originalCode`).
 */
function sqlStateOf(error: PrismaErrorLike): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  const raw = cause?.code ?? cause?.originalCode;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The constraint that fired. Prisma is inconsistent about where it puts the
 * name — a unique index arrives in `constraint.index`, a foreign key only
 * inside the original message — so both places are read, anchored on the exact
 * wording PostgreSQL uses so nothing else in the message can pose as a
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
 * The unique indexes of this module, each mapped to the domain error whose
 * code the SPEC fixes (OR-002, OR-020, OR-024). The migration
 * `20260813025017_organization_establishment_and_emission_points` is where the
 * new names are born; `site_msp_unicode_key` and `site_room_site_id_name_key`
 * are Prisma's own, from `20260806022931_clinical_core`.
 *
 * Adding an index without a line here means the client gets a generic
 * `DUPLICATE_VALUE` instead of the contracted code.
 */
const DUPLICATE_BY_CONSTRAINT: Record<string, () => DomainError> = {
  establishment_msp_unicode_unique: () => new MspUnicodeDuplicateError(),
  site_msp_unicode_key: () => new MspUnicodeDuplicateError(),
  site_room_site_id_name_key: () => new SiteRoomDuplicateError(),
  emission_point_code_unique_per_site: () => new EmissionPointDuplicateError(),
  site_sri_establishment_code_unique_per_ruc: () =>
    new SriEstablishmentCodeDuplicateError(),
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
 * captured live: a `P2039` whose `meta` is EMPTY and whose message carries the
 * SQLSTATE and the constraint. Anchored on PostgreSQL's own wording.
 */
const RESTRICTED_DELETE =
  /violates (?:RESTRICT setting of )?foreign key constraint/;

/**
 * Whether a DELETE was refused because rows still reference the target
 * (`ON DELETE RESTRICT`: SQLSTATE 23001, or 23503 for a plain FK). The caller
 * knows WHICH entity it was deleting, so it — not a name table — picks between
 * `SITE_IN_USE` and `SITE_ROOM_IN_USE` (OR-006, OR-022). Only ever called in a
 * delete's catch block.
 */
export function isForeignKeyRestriction(error: unknown): boolean {
  if (!isPrismaError(error)) return false;

  const sqlState = sqlStateOf(error);
  if (sqlState === '23001' || sqlState === '23503') return true;

  // `P2039` arrives with an empty `meta`, so the SQLSTATE and constraint
  // survive only in the outer message.
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
