import type { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  EmailAlreadyRegisteredError,
  RoleCodeDuplicateError,
} from '../domain/auth.errors';

/**
 * Reads which authorisation constraint PostgreSQL raised, so the repositories
 * can throw the domain error whose code the SPEC fixes.
 *
 * SAME SHAPE AS `organization-database-errors.ts`, AND NOT SHARED WITH IT. The
 * duplication is four small functions; sharing them would put a file in
 * `shared/` that every module has to agree on before changing, and the lists
 * of constraint names — the only part that matters — have nothing in common.
 *
 * PHI WARNING, same as `database-problem.ts`: the offending row rides in the
 * driver's `detail`, and here that row is an email address. Only the
 * CONSTRAINT NAME is read, and every message thrown is written by hand in the
 * domain error classes.
 */

/** Shape of a Prisma error. Local so this file does not import Prisma. */
interface PrismaErrorLike {
  code?: unknown;
  clientVersion?: unknown;
  message?: unknown;
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

function messageOf(error: PrismaErrorLike): string {
  const original = error.meta?.driverAdapterError?.cause?.originalMessage;
  const outer = error.message;
  return [
    typeof original === 'string' ? original : '',
    typeof outer === 'string' ? outer : '',
  ].join(' ');
}

function constraintNameOf(error: PrismaErrorLike): string | undefined {
  const cause = error.meta?.driverAdapterError?.cause;
  if (!cause) return undefined;

  const index = cause.constraint?.index;
  if (typeof index === 'string') return index;

  return /violates (?:unique|check|exclusion|foreign key) constraint "([^"]+)"/.exec(
    messageOf(error),
  )?.[1];
}

/**
 * The unique indexes of this module's administration half, each mapped to the
 * domain error whose code the SPEC fixes (AU-020, AU-030).
 *
 * `app_user_email_key` and `role_code_key` are Prisma's own names, from
 * `20260806011036_init` and `20260806052444_roles_as_data`.
 */
const DUPLICATE_BY_CONSTRAINT: Record<string, () => DomainError> = {
  app_user_email_key: () => new EmailAlreadyRegisteredError(),
  role_code_key: () => new RoleCodeDuplicateError(),
};

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
 * Whether a DELETE was refused because grants still reference the role
 * (AU-031). The caller knows it was deleting a role, so it — not a name table
 * — decides that this means `ROLE_IN_USE`.
 */
export function isForeignKeyRestriction(error: unknown): boolean {
  if (!isPrismaError(error)) return false;

  const sqlState = sqlStateOf(error);
  if (sqlState === '23001' || sqlState === '23503') return true;

  return RESTRICTED_DELETE.test(messageOf(error));
}

/**
 * AU-031, from the database's own mouth.
 *
 * `trg_role_protect_system` raises `insufficient_privilege` (42501) when a
 * system role is deleted or its code changed. The service refuses earlier so
 * the answer does not depend on a PostgreSQL message, and this is the net for
 * a write that reached the base another way — a data import, a script.
 */
export function isSystemRoleProtection(error: unknown): boolean {
  if (!isPrismaError(error)) return false;
  if (sqlStateOf(error) === '42501') return true;

  return /system role .* cannot be deleted|code of system role/.test(
    messageOf(error),
  );
}

/**
 * The statement-level trigger `trg_role_permission_keep_an_administrator`
 * firing: at least one active role must keep `user:manage`.
 *
 * The last line of defence for AU-024, and the only one that holds against a
 * `DELETE FROM role_permission` typed straight into `psql`.
 */
export function isLastAdministratorProtection(error: unknown): boolean {
  if (!isPrismaError(error)) return false;

  return /at least one active role must keep user:manage/.test(
    messageOf(error),
  );
}

/** Prisma's "the row this operation depended on is gone" (update/delete by id). */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}
