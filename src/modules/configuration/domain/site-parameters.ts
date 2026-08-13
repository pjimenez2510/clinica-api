import type { DomainFieldError } from '../../../shared/domain/errors/domain-error';

import { ParameterOutOfRangeError } from './configuration.errors';

/**
 * The four operating numbers of a site, and what they are allowed to be
 * (CF-062, CF-065, D-001).
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

export interface SiteParameters {
  minLeadMinutes: number;
  maxLeadDays: number;
  overbookingCap: number;
  cancelledRetention: CancelledRetention;
}

/** What the administrator may send; anything absent keeps its stored value. */
export type SiteParametersPatch = Partial<SiteParameters>;

interface Range {
  min: number;
  max: number;
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
} as const satisfies Record<string, Range>;

export type RangedParameter = keyof typeof PARAMETER_RANGES;

/** The values a fresh site starts with (D-001). */
export const DEFAULT_SITE_PARAMETERS: SiteParameters = {
  minLeadMinutes: 0,
  maxLeadDays: 180,
  overbookingCap: 2,
  cancelledRetention: 'NEVER',
};

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

    const range = PARAMETER_RANGES[key];
    if (Number.isInteger(value) && value >= range.min && value <= range.max) {
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
