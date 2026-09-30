/**
 * The registry of what each database constraint means to the person who hit
 * it. Shared owns the MACHINERY; each module owns its ENTRIES.
 *
 * WHY IT IS NOT ONE BIG MAP IN `database-problem.ts` ANY MORE. It was, and
 * with four modules it already mixed agenda, patients and catalogs — with six
 * modules to come, every new constraint meant editing a shared file that no
 * module owns, growing without structural limit toward a sixty-entry map
 * (maintainability review, finding 3). Now `agenda.constraints.ts` lives in
 * the agenda module, next to the migration that creates the constraints it
 * names, and shared grows by zero per module.
 *
 * Registration happens at import time from each module's `*.constraints.ts`;
 * the module's `*.module.ts` imports it, so booting the app registers
 * everything. A test that calls `extractDatabaseProblem` directly imports the
 * constraint file of the module it exercises — explicit, like any dependency.
 *
 * An unregistered constraint is NOT an error at lookup time: the SQLSTATE
 * fallback in `database-problem.ts` still produces the correct status and a
 * generic message. The registry only upgrades the message.
 */

/**
 * What the response says for one constraint: the stable code, the field to
 * highlight, and the Spanish sentence the user reads.
 */
export interface ConstraintMeaning {
  code: string;
  field: string;
  message: string;
}

/** Process-wide, filled at import time by each module's `*.constraints.ts`. */
const MEANINGS = new Map<string, ConstraintMeaning>();

/**
 * Registering a constraint twice with DIFFERENT codes throws at import time on
 * purpose: two modules claiming the same constraint is a wiring bug, and the
 * first request that hits it is the worst moment to discover which one won.
 * A second registration with the SAME code does not throw: it silently
 * replaces the earlier entry, `field` and `message` included.
 */
export function registerConstraintMeanings(
  entries: Record<string, ConstraintMeaning>,
): void {
  for (const [constraint, meaning] of Object.entries(entries)) {
    const existing = MEANINGS.get(constraint);
    if (existing && existing.code !== meaning.code) {
      throw new Error(
        `Constraint "${constraint}" registered twice with different codes: ` +
          `${existing.code} and ${meaning.code}`,
      );
    }
    MEANINGS.set(constraint, meaning);
  }
}

/**
 * `undefined` for an unregistered constraint; the SQLSTATE fallback in
 * `database-problem.ts` then answers with a generic message.
 */
export function constraintMeaningOf(
  constraint: string,
): ConstraintMeaning | undefined {
  return MEANINGS.get(constraint);
}
