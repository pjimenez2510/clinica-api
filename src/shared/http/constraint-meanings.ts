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

export interface ConstraintMeaning {
  code: string;
  field: string;
  message: string;
}

const MEANINGS = new Map<string, ConstraintMeaning>();

/**
 * Duplicate registration throws at import time on purpose: two modules
 * claiming the same constraint is a wiring bug, and the first request that
 * hits it is the worst moment to discover which one won.
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

export function constraintMeaningOf(
  constraint: string,
): ConstraintMeaning | undefined {
  return MEANINGS.get(constraint);
}
