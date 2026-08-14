/**
 * The atom of the agenda (D-021): the increment a site dices its day into, and
 * the number every configurable duration has to be a multiple of.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until 14-08-2026 there were TWO free numbers that had to agree and nothing
 * made them: the `slot_minutes` of each schedule rule and the base duration of
 * each specialty·type. The database already held grids of 20 and 30 minutes
 * against types of 10, 20 and 30 — a 20-minute type on a doctor with a
 * 30-minute grid was already impossible to book (AG-012 refuses it) and no
 * screen crossed the two. The established practice in ambulatory scheduling is
 * one small increment that every appointment is a multiple of, so the grid
 * became a single number per site and the durations became multiples of it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IN `shared/domain` AND NOT IN A MODULE, AND WHICH PART OF IT IS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THREE modules validate against the atom for their own reasons — `specialties`
 * for the base duration of a service type (SP-021), `staff` for the
 * per-practitioner exception (SP-022, ST-009), and `configuration` for the
 * atom itself when it is being changed (CF-062) — and
 * `dependency-cruiser`'s `sin-imports-entre-modulos` refuses an import from one
 * module into another outright. This is the path `resolveDuration`,
 * `clinic-time` and `INVALID_RUC` already took, and for the same reason.
 *
 * WHAT IS **NOT** HERE: the default value of the atom and its admissible
 * range. Those are `configuration`'s statement about what a site is created
 * with and what an administrator may save, and `agenda`'s statement about what
 * the booking path operates with when nothing is stored (AG-095) — the same
 * split, and for the same reason, as `DEFAULT_BOOKING_PARAMETERS`. A shared
 * constant would tie the modules together through a number each reads for a
 * different purpose.
 *
 * PURE: no I/O, no clock, no framework.
 */

import { DurationNotSlotMultipleError } from './errors/slot-atom.errors';

/**
 * Whether a duration fits the grid whole.
 *
 * `> 0` is part of the question and not a guard bolted on: zero minutes is an
 * exact multiple of every atom and is not an appointment.
 */
export function isSlotMultiple(minutes: number, atom: number): boolean {
  return Number.isInteger(minutes) && minutes > 0 && minutes % atom === 0;
}

/**
 * The atom every clinic-wide duration has to answer to, given what each site
 * dices its day into.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESIGN QUESTION THIS FUNCTION IS THE ANSWER TO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The atom belongs to a SITE (D-021) and a service type belongs to the CLINIC:
 * `service_type` has no `site_id` and never had one, because «Primera vez de
 * Cardiología» is the same visit wherever it is given. So a duration has to be
 * validated against something, and there were three candidates.
 *
 *   * **The clinic's atom** — which, today, is the column default of
 *     `site_parameter.slot_atom_minutes` (AG-095 has no clinic-level table:
 *     the trigger writes the clinic's values into every site's row). REJECTED:
 *     it is the value a site is BORN with, not the value it HAS. The moment
 *     one site changes its atom, a duration validated against the default
 *     guarantees nothing about that site — and the reachable incoherence
 *     D-021 exists to remove would be back, just moved to «the other site».
 *
 *   * **Every site's atom** — the duration must divide evenly at all of them.
 *     CHOSEN, because a type that can be offered anywhere has to be bookable
 *     anywhere. A duration valid at some sites and not others does not fix the
 *     problem; it makes it harder to see, since the screen that configures the
 *     type has no site on it to warn about.
 *
 *   * **The lowest common multiple** — which is the SAME rule, stated as one
 *     number: a duration is a multiple of every atom exactly when it is a
 *     multiple of their LCM. That is what this returns, because one number is
 *     what the refusal has to name.
 *
 * WHAT THIS COSTS, SAID OUT LOUD. Sites with atoms of 10 and 15 admit only
 * multiples of 30, so a 20-minute control becomes unconfigurable clinic-wide.
 * That is not a defect of the rule but the true shape of the constraint: a
 * 20-minute appointment genuinely cannot be placed on a 15-minute grid, and
 * the only alternative to saying so at configuration time is saying it at the
 * counter, one booking at a time, which is what D-021 set out to end.
 *
 * `null` for an empty set: with no site there is no grid, so no duration can
 * fail to fit one. It is not a hole — the range CHECKs of
 * `service_type_duration_range` and `duration_exception_range` still hold —
 * and it is only reachable on a database with no sites at all.
 */
export function clinicSlotAtom(atoms: readonly number[]): number | null {
  const usable = atoms.filter((atom) => Number.isInteger(atom) && atom > 0);
  if (usable.length === 0) return null;

  return usable.reduce(lowestCommonMultiple);
}

function lowestCommonMultiple(a: number, b: number): number {
  return (a / greatestCommonDivisor(a, b)) * b;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The sentence the refusal carries. It NAMES THE ATOM, which is the whole
 * point: «duración inválida» sends an administrator to read the source code,
 * and the number is the one thing that tells them what to type instead.
 */
export function slotMultipleMessage(atom: number): string {
  return `La duración debe ser múltiplo de ${atom} minutos, que es el turno de la agenda`;
}

/**
 * Refuses a duration that does not tile the grid, naming the field the screen
 * must highlight and the number to type instead.
 *
 * ONE FUNCTION AND NOT THREE COPIES: `specialties`, `staff` and `configuration`
 * all have to refuse this, and three transcriptions of the same six lines is
 * how the message on one screen stops matching the message on another.
 *
 * A `null` atom is a no-op — see `clinicSlotAtom`: there is no grid to fit.
 */
export function assertDurationFitsSlotAtom(
  field: string,
  minutes: number,
  atom: number | null,
): void {
  if (atom === null || isSlotMultiple(minutes, atom)) return;

  throw new DurationNotSlotMultipleError([
    {
      field,
      code: 'DURATION_NOT_SLOT_MULTIPLE',
      message: slotMultipleMessage(atom),
    },
  ]);
}
