import type { DomainFieldError } from '../../../shared/domain/errors/domain-error';
import { UnknownPermissionError } from '../../../shared/domain/errors/permission.errors';
import { isSlotMultiple } from '../../../shared/domain/slot-atom';

import { ParameterOutOfRangeError } from './configuration.errors';

/**
 * The operating parameters of a site — the four numbers of D-001 and the past
 * booking switch of AG-094 — and what they are allowed to be (CF-062, CF-065).
 *
 * PURE DOMAIN: no I/O, no clock, no framework. The ranges are declared once
 * here and mirrored by the CHECK constraints of
 * `20260813040610_configuration_holidays_and_site_parameters`. Two copies, and
 * that is deliberate rather than sloppy — the application must answer
 * `PARAM_OUT_OF_RANGE` NAMING the range, which a `23514` from PostgreSQL
 * cannot do, and the base must refuse the same value when the write arrives
 * from a data import or a `psql`. An integration test asserts the two agree by
 * sending a value the DTO would never let through.
 */

/**
 * Retention of cancelled appointments.
 *
 * ONE value, because D-004 decided the system never deletes clinical history
 * and D-001 chose «no borrar» for cancelled appointments. Declared as a closed
 * union rather than a boolean so adding a purge policy later is a value in
 * this list plus a column, not a rewrite of everything that reads it.
 */
export const CANCELLED_RETENTION_POLICIES = ['NEVER'] as const;
export type CancelledRetention = (typeof CANCELLED_RETENTION_POLICIES)[number];

/**
 * One site's operating parameters as stored in `site_parameter`. The ranges of
 * the numeric ones live in `PARAMETER_RANGES` below, mirrored by CHECK
 * constraints in the database.
 */
export interface SiteParameters {
  minLeadMinutes: number;
  maxLeadDays: number;
  overbookingCap: number;
  /**
   * D-021, CF-062. The atom of the agenda: the increment this site dices its
   * day into. Every slot the agenda offers lasts exactly this, and every
   * configurable duration — the base of a specialty·type and a practitioner's
   * exception — has to be a multiple of it.
   *
   * IT IS A RANGED PARAMETER LIKE THE OTHER THREE, so `assertParametersInRange`
   * sees it; but unlike them it also has to answer to what is ALREADY stored,
   * because durations were saved against the atom it is replacing. That second
   * half is `assertAtomFitsStoredDurations` and it needs a read, so it lives in
   * the service.
   */
  slotAtomMinutes: number;
  /**
   * AG-031, AG-094. The site accepts a start earlier than now, which is how an
   * attention that already happened gets recorded after the fact.
   *
   * A BOOLEAN, so it has no range and `assertParametersInRange` never sees it:
   * both of its values are legitimate and the only decision is which one the
   * site wants. What makes it safe to configure is the same thing that makes
   * the other four safe (CF-063): no guarantee depends on its value. The
   * `EXCLUDE` still arbitrates overlap over a past hour, the status history is
   * still append-only, and booking still demands `agenda:write` over the site.
   */
  allowPastBooking: boolean;
  /**
   * AG-039, AG-094. The site admits overbookings.
   *
   * A BOOLEAN LIKE `allowPastBooking` AND WITH THE OPPOSITE DEFAULT, which is
   * a decision and not an inconsistency: the overbooking is the DOCUMENTED way
   * of breaking the grid (D-005), and a site that shipped with it closed would
   * still have urgencies — resolved on paper, or by annulling somebody else's
   * appointment. What keeps it from becoming the normal route is
   * `overbookingCap`, which is a number this screen already administers.
   */
  overbookingEnabled: boolean;
  /**
   * AG-101, AG-094. Which permission a person must hold to authorise an
   * overbooking at this site.
   *
   * ⚠️ A PERMISSION CODE STORED AS DATA, and the only one in this schema. What
   * permissions EXIST is code — each corresponds to a check, so one invented
   * in a row protects nothing — so this column is checked against the
   * catalogue before it is written (`assertPermissionIsDeclared`) and against
   * the installed mirror by a foreign key. Left open, a typo would silently
   * mean «nobody may authorise» and the sede would lose its overbookings with
   * nothing saying why.
   */
  overbookingPermission: string;
  /**
   * AG-066, AG-094. How many contact attempts exhaust a waiting list entry at
   * this site.
   *
   * ⚠️ THE NUMBER IS THE CLINIC'S AND NOT OURS. D-001 fixed the starting
   * values of the other parameters and did not include this one; D-040 (a) is
   * open with a recommendation of 3, which is what the column defaults to.
   * Being wrong about it costs a screen and not a migration, which is the whole
   * point of it being a site parameter (REQ-145).
   */
  waitlistMaxContactAttempts: number;
  cancelledRetention: CancelledRetention;
}

/** What the administrator may send; anything absent keeps its stored value. */
export type SiteParametersPatch = Partial<SiteParameters>;

/**
 * A declared range: bounds, optional step, and the Spanish sentence
 * `PARAM_OUT_OF_RANGE` shows.
 */
interface Range {
  min: number;
  max: number;
  /**
   * The increment the value has to land on, when it has one. Absent means
   * «any integer inside the range».
   */
  step?: number;
  /** Written into the message, so the range reads as a sentence. */
  describe: (min: number, max: number) => string;
}

/**
 * The declared range of each number.
 *
 * THE UPPER BOUNDS ARE NOT DECORATION. Seven days of minimum lead already
 * stops reception from booking the patient standing at the counter, which is
 * the case AG-032 exists for; two years of maximum lead exceeds any schedule
 * that has been published; and twenty overbookings turn the exception into the
 * normal route. A range nobody can reach is not a range.
 */
export const PARAMETER_RANGES = {
  minLeadMinutes: {
    min: 0,
    max: 10_080,
    describe: (min, max) =>
      `La antelación mínima va de ${min} a ${max} minutos (7 días)`,
  },
  maxLeadDays: {
    min: 1,
    max: 730,
    describe: (min, max) =>
      `La antelación máxima va de ${min} a ${max} días (2 años)`,
  },
  overbookingCap: {
    min: 0,
    max: 20,
    describe: (min, max) => `El tope de sobrecupos va de ${min} a ${max}`,
  },
  /**
   * D-021. Mirrors `site_parameter_slot_atom_minutes_range`.
   *
   * THE STEP OF 5 IS WHAT KEEPS THE DATABASE HONEST. `service_type_duration_range`
   * and `duration_exception_range` demand multiples of 5, and a `CHECK` cannot
   * reach `site_parameter` to demand the multiple of the atom instead. With
   * the atom itself restricted to multiples of 5, that table-local rule stops
   * being a leftover that contradicts the sharp one and becomes a consequence
   * of it.
   *
   * THE ENDS: below 5 the grid is noise — nobody operates a one-minute agenda
   * — and above 60 there is no documented band at all. The standard band of
   * ambulatory scheduling (10, 15, 20) falls inside.
   */
  slotAtomMinutes: {
    min: 5,
    max: 60,
    step: 5,
    describe: (min, max) =>
      `El turno de la agenda va de ${min} a ${max} minutos, de 5 en 5`,
  },
  /**
   * AG-066, AG-094. Mirrors `site_parameter_waitlist_max_contact_attempts_range`.
   *
   * THE ENDS ARE OURS AND THE VALUE IS NOT. At 0 the entry would expire before
   * the first call and the list would phone nobody; above 10 «agotar los
   * intentos» stops closing anything and the slot is held for days waiting on
   * somebody who does not answer. Which number inside that band is a decision
   * of the clinic (D-040).
   */
  waitlistMaxContactAttempts: {
    min: 1,
    max: 10,
    describe: (min, max) =>
      `Los intentos de contacto de la lista de espera van de ${min} a ${max}`,
  },
} as const satisfies Record<string, Range>;

/**
 * The parameters that have a declared range; the booleans, the permission code
 * and the retention policy do not.
 */
export type RangedParameter = keyof typeof PARAMETER_RANGES;

/**
 * The values a fresh site starts with (D-001).
 *
 * `allowPastBooking` is `false` and that is not a D-001 number: it is the
 * column default the migration of E7 wrote, and the conservative one on
 * purpose. A site opens the past because it needs to record after the fact,
 * which is its decision; shipping it open would be ours.
 */
export const DEFAULT_SITE_PARAMETERS: SiteParameters = {
  minLeadMinutes: 0,
  maxLeadDays: 180,
  overbookingCap: 2,
  /**
   * D-021: 10 minutes, and it is not an arbitrary pick. It is the only value
   * of the standard band (10, 15, 20) that 10, 20 and 30 — the three durations
   * already configured when the decision was taken — are all multiples of, so
   * no existing row was left incoherent by the change.
   */
  slotAtomMinutes: 10,
  allowPastBooking: false,
  /**
   * D-005, decided by the user on 14-08-2026: ENABLED out of the box. See the
   * field, and the migration `agenda_overbooking_authorisation`.
   */
  overbookingEnabled: true,
  /** D-005: the permission MEDICO and ADMIN carry out of the box. */
  overbookingPermission: 'agenda:overbook',
  /** D-040 (a), recommendation pending the clinic's answer. The column default. */
  waitlistMaxContactAttempts: 3,
  cancelledRetention: 'NEVER',
};

/**
 * CF-065's shape applied to a value that is not a number: the code has to be
 * one the CATALOGUE declares (AG-101, AU-033).
 *
 * WHY THE CATALOGUE AND NOT A LIST OF «THE ONES THAT MAKE SENSE HERE». Any
 * permission is a defensible answer to «who may authorise an exception» — a
 * clinic could decide it is whoever holds `settings:manage` — and narrowing it
 * here would be this module deciding the clinic's policy. What is NOT
 * defensible is a code that exists nowhere: it protects nothing, no route
 * grants it, and the site would quietly lose its overbookings.
 *
 * THE INSTALLED MIRROR IS A DIFFERENT QUESTION and is not asked here: it needs
 * a read, so it lives in the service, and the foreign key answers it for
 * whatever bypasses both (`PERMISSION_NOT_INSTALLED`).
 */
export function assertPermissionIsDeclared(
  code: string,
  declared: readonly string[],
): void {
  if (declared.includes(code)) return;

  throw new UnknownPermissionError([code], 'overbookingPermission');
}

/**
 * CF-065. Refuses the whole write when any number is outside its range, and
 * says which ones and what the range is.
 *
 * EVERY offending field travels, not just the first: an administrator fixing
 * one number at a time through four round trips is how a configuration screen
 * gets abandoned half-configured.
 *
 * `Number.isInteger` is checked here as well as in the DTO because this
 * function is the last thing between a caller and the database, and `2.5`
 * overbookings would otherwise be silently truncated by PostgreSQL's `int`.
 */
export function assertParametersInRange(patch: SiteParametersPatch): void {
  const errors: DomainFieldError[] = [];

  for (const key of Object.keys(PARAMETER_RANGES) as RangedParameter[]) {
    const value = patch[key];
    if (value === undefined) continue;

    const range: Range = PARAMETER_RANGES[key];
    const step = range.step ?? 1;
    if (
      Number.isInteger(value) &&
      value >= range.min &&
      value <= range.max &&
      value % step === 0
    ) {
      continue;
    }

    errors.push({
      field: key,
      code: 'PARAM_OUT_OF_RANGE',
      message: range.describe(range.min, range.max),
    });
  }

  if (errors.length > 0) throw new ParameterOutOfRangeError(errors);
}

/**
 * D-021, the OTHER half of «AG-012 y AG-104 se cumplen por construcción».
 *
 * WHY THERE ARE TWO HALVES AND NOT ONE. Making every duration a multiple of
 * the atom closes the door the durations come through; it does nothing about
 * the door the ATOM comes through. A clinic with 10-, 20- and 30-minute types
 * that moves a site to a 20-minute grid has just made every 30-minute type
 * unbookable there — the very incoherence D-021 removed, walked back in
 * through configuration. So the atom answers to what is already stored, and
 * the guarantee is symmetric: the set of atoms and the set of durations must
 * be mutually compatible, whichever side is being written.
 *
 * IT NAMES THE DURATIONS THAT DO NOT FIT, and that is the difference between
 * a refusal and an obstacle: «no puede ser 20» leaves an administrator
 * guessing which of forty service types is in the way.
 *
 * `stored` is what the WHOLE clinic has configured, not this site's — a
 * service type has no site (see `clinicSlotAtom`).
 */
export function assertAtomFitsStoredDurations(
  atom: number,
  stored: readonly number[],
): void {
  const stranded = [...new Set(stored)]
    .filter((minutes) => !isSlotMultiple(minutes, atom))
    .sort((a, b) => a - b);

  if (stranded.length === 0) return;

  throw new ParameterOutOfRangeError([
    {
      field: 'slotAtomMinutes',
      code: 'PARAM_OUT_OF_RANGE',
      message: `Con turnos de ${atom} minutos quedarían sin poder reservarse las duraciones ya configuradas de ${stranded.join(', ')} minutos. Ajústelas primero`,
    },
  ]);
}

/**
 * The window has to be usable once the patch is applied.
 *
 * Mirrors `site_parameter_lead_window_coherent`. It takes the RESULT and not
 * the patch because the two numbers can arrive in different requests: raising
 * the minimum lead to five days is fine today and absurd tomorrow, after
 * somebody lowers the maximum to four.
 */
export function assertLeadWindowCoherent(result: SiteParameters): void {
  if (result.minLeadMinutes <= result.maxLeadDays * 1440) return;

  throw new ParameterOutOfRangeError([
    {
      field: 'minLeadMinutes',
      code: 'PARAM_OUT_OF_RANGE',
      message:
        'La antelación mínima no puede superar la máxima: la sede se quedaría sin ninguna hora reservable',
    },
  ]);
}
