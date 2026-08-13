/**
 * How long an appointment should last — the D-010 contract, in one function.
 *
 * SP-023 fixes the order: the practitioner's own exception wins, then the
 * base duration of the specialty·type, then the minutes of the schedule rule.
 * It is trivial arithmetic ON PURPOSE: the value of having it here is that
 * the agenda (SP-028), the administration screen and every test resolve the
 * duration through the SAME function, so the proposal recepción sees and the
 * length the booking enforces cannot drift apart.
 *
 * IN `shared/domain` AND NOT IN `specialties`, since 13-08-2026. When ST-009
 * absorbed the per-practitioner duration exception, the only caller left was
 * `staff`, and `dependency-cruiser`'s `sin-imports-entre-modulos` rule refuses
 * an import from one module into another — it is not a preference, it is a
 * build error. The choice was between duplicating four lines of arithmetic in
 * two modules and moving the function to the layer both may read; a duplicated
 * hierarchy is exactly what this function exists to prevent. Same path
 * `clinic-time` took, and for the same reason.
 */

export interface DurationSources {
  /** The practitioner's own exception for this specialty·type, if any. */
  exceptionMinutes?: number | null;
  /** The base duration of the service type, if one applies. */
  serviceTypeMinutes?: number | null;
  /** The slot minutes of the schedule rule in force, the last resort. */
  ruleSlotMinutes?: number | null;
}

/**
 * The duration in force, or `null` when no source knows one.
 *
 * `null` and not a throw: whether "no duration anywhere" is an error depends
 * on who is asking — the administration listing always has a base, while the
 * agenda always has a rule — and this function does not know its caller.
 */
export function resolveDuration(sources: DurationSources): number | null {
  return (
    sources.exceptionMinutes ??
    sources.serviceTypeMinutes ??
    sources.ruleSlotMinutes ??
    null
  );
}
