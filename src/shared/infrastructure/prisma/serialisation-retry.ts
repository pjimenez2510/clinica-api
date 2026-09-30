/**
 * Retrying what PostgreSQL aborted for serialisation.
 *
 * WHY IT IS SHARED AND NOT INSIDE THE AGENDA. Any write that competes for the
 * same rows meets `40001`: booking an appointment today, issuing an invoice
 * sequence and closing an encounter tomorrow. The rule — retry a transient
 * abort, never retry a constraint rejection — is the same everywhere, and the
 * version that gets it wrong is the one written again in a hurry.
 *
 * WHY IT LIVES BESIDE THE PRISMA SERVICE AND NOT IN `domain`: it exists to
 * read a driver error and to wait. Both are I/O concerns, and `domain` has
 * neither a clock nor an error shape from a database.
 *
 * NO PRISMA IMPORT, on purpose: only the SHAPE of the error is read, the same
 * way `shared/http/database-problem.ts` does it. Importing the client here
 * would drag the ORM into every module that only wants to retry.
 */

/**
 * Class 40: transaction rollback.
 *
 *   - `40001` serialization_failure — the classic one.
 *   - `40P01` deadlock_detected — two transactions waiting on each other; one
 *     is chosen and killed, and it should try again.
 *
 * Nothing else belongs here. A `23P01` exclusion violation means the slot is
 * genuinely taken and retrying it would fail forever while a receptionist
 * waits for an answer she could already act on.
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01']);

/**
 * Where the driver carries the SQLSTATE. Both keys are read; see
 * `isSerialisationFailure`.
 */
interface SqlStateCause {
  code?: unknown;
  originalCode?: unknown;
}

/**
 * The two shapes Prisma delivers a driver failure in, depending on how the
 * statement ran.
 */
interface DriverErrorLike {
  /** A statement outside a transaction: Prisma wraps the driver error. */
  meta?: { driverAdapterError?: { cause?: SqlStateCause } };
  /** An interactive transaction: the `DriverAdapterError` arrives bare. */
  cause?: SqlStateCause;
}

/**
 * True when PostgreSQL asked us to try the whole transaction again.
 *
 * TWO PLACES, AND BOTH WERE CAPTURED FROM A LIVE POSTGRESQL 18, not guessed.
 * Prisma delivers the SQLSTATE differently depending on how the statement ran:
 *
 *   - a plain `create` (its own implicit transaction) arrives as a Prisma
 *     error carrying `meta.driverAdapterError.cause.code`;
 *   - a failure inside `$transaction` arrives as a bare `DriverAdapterError`
 *     — no `P####` code at all — with `cause.originalCode`.
 *
 * Reading only the first is how a retry silently stops retrying, so
 * `agenda-daily.spec.ts` provokes a real `40001` and asserts this function
 * recognises what the driver actually threw.
 */
export function isSerialisationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as DriverErrorLike;
  const causes = [candidate.meta?.driverAdapterError?.cause, candidate.cause];

  // Both keys are inspected INDEPENDENTLY, never `code ?? originalCode`:
  // driver shapes exist where `cause.code` is present but holds something
  // that is not a SQLSTATE (a kind, a driver tag), and `??` would then never
  // look at `originalCode` — a retry that silently stopped retrying, found
  // by adversarial review (P2-3).
  return causes.some((cause) =>
    [cause?.code, cause?.originalCode].some(
      (raw) => typeof raw === 'string' && TRANSIENT_SQLSTATES.has(raw),
    ),
  );
}

/** Tuning for `withSerialisationRetry`; every field has a default. */
export interface SerialisationRetryOptions {
  /**
   * Total attempts INCLUDING the first. Three by default: enough to survive
   * the contention two receptionists produce, short enough that a genuinely
   * hot row fails fast instead of holding a connection for a second.
   */
  attempts?: number;
  /** Base wait in milliseconds. Doubles per attempt. */
  delayMs?: number;
  /** Injected so a test does not have to wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with the number of the attempt that just failed. For logging. */
  onRetry?: (attempt: number) => void;
}

/**
 * Three attempts starting at 20 ms; see `SerialisationRetryOptions.attempts`
 * for why three.
 */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 20;

/** The production sleep; tests inject their own through `options.sleep`. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the operation, retrying only a transient abort.
 *
 * Rethrows the LAST failure once the budget is spent, so the caller decides
 * what that means: the agenda turns it into a 503 with `Retry-After` (AG-026)
 * rather than into a slot conflict, which would tell a receptionist to pick
 * another time for a slot that was never taken.
 *
 * The wait grows and is jittered. Retrying two colliding transactions after
 * exactly the same delay reproduces the collision, which is the classic way a
 * retry loop turns contention into a stampede.
 */
export async function withSerialisationRetry<T>(
  operation: () => Promise<T>,
  options: SerialisationRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isSerialisationFailure(error)) throw error;

      options.onRetry?.(attempt);
      const backoff = delayMs * 2 ** (attempt - 1);
      await sleep(Math.round(backoff * (0.5 + Math.random() / 2)));
    }
  }
}
