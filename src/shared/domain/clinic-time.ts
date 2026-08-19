/**
 * Time in the clinic: the date is the date in Ecuador, never the one on the
 * host (AG-001), and a weekly schedule rule is wall-clock time, not an instant
 * (AG-002).
 *
 * WHY THE OFFSET IS DERIVED AND NEVER WRITTEN DOWN. Mainland Ecuador has no
 * daylight saving and has been UTC-5 for decades, so `instant - 5h` looks
 * correct and is cheaper. It is also how every date bug of this kind starts:
 * the constant survives the decree that changes it, and it is wrong the moment
 * anyone reads a rule for a zone that does move — including `Pacific/Galapagos`
 * at UTC-6, which the environment schema already accepts. Everything here asks
 * `Intl` for the offset of a specific instant in a specific zone. Nothing in
 * this file knows what that offset is.
 *
 * No dependency: `Intl` ships with Node and `Temporal` is not available on
 * Node 24 without a polyfill. Adding `date-fns`/`@date-fns/tz` — the only two
 * the architecture rules would even allow into `domain` — would buy formatting
 * helpers this module does not need.
 */

/**
 * The clinic operates in one zone and it is not configurable (SPEC §10).
 * Every function takes it as a defaulted parameter anyway, which is what makes
 * the daylight-saving behaviour testable at all: a zone that moves proves the
 * offset is read, not assumed.
 */
export const CLINIC_TIME_ZONE = 'America/Guayaquil';

declare const CLINICAL_DATE_BRAND: unique symbol;

/**
 * A calendar date in Ecuador, `YYYY-MM-DD`. Not an instant.
 *
 * Branded: an arbitrary string no longer compiles where a validated date is
 * expected — with this file in `shared/` every new module becomes a caller,
 * and "any string works" is how an unvalidated `req.query` value ends up in a
 * date comparison. `parseClinicalDate` and `clinicalDateOf` are the two ways
 * to produce one.
 */
export type ClinicalDate = string & { readonly [CLINICAL_DATE_BRAND]: true };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * A guard, not a policy: an availability query is bounded by the caller, and a
 * typo of four digits in a year must not turn into a loop over a million days.
 *
 * EXPORTED so the HTTP boundary can refuse an over-long range as a per-field
 * validation error instead of letting `clinicalDatesBetween` raise a
 * `RangeError` that reaches the client as a 500. One number, two enforcement
 * points: the DTO says it politely, this file guarantees it for every caller,
 * including the ones that never go through HTTP.
 */
export const MAX_RANGE_DAYS = 366;

/** Validates and normalises a `YYYY-MM-DD` date, calendar included. */
export function parseClinicalDate(value: string): ClinicalDate {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Clinical date must be YYYY-MM-DD: ${value}`);
  }
  const [, year, month, day] = match;
  const utc = new Date(`${year}-${month}-${day}T00:00:00Z`);
  // Rejects 2026-02-30 and friends: `Date` rolls them over silently, so the
  // round trip is the check.
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Clinical date is not a real calendar date: ${value}`);
  }
  return value as ClinicalDate;
}

/**
 * Minutes to add to UTC to obtain the wall clock of `timeZone` at `instant`.
 * Negative west of Greenwich: -300 for Ecuador.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)?.value;
    return found === undefined ? Number.NaN : Number.parseInt(found, 10);
  };

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );

  // Seconds resolution is enough: no IANA zone has had a sub-minute offset
  // since 1900, and the instant's own milliseconds cancel out.
  return Math.round((asUtc - instant.getTime()) / MS_PER_MINUTE);
}

/** The date that instant falls on, in Ecuador. */
export function clinicalDateOf(
  instant: Date,
  timeZone: string = CLINIC_TIME_ZONE,
): ClinicalDate {
  const offset = zoneOffsetMinutes(instant, timeZone);
  return new Date(instant.getTime() + offset * MS_PER_MINUTE)
    .toISOString()
    .slice(0, 10) as ClinicalDate;
}

/**
 * The instant at which `time` strikes on `date` in `timeZone`.
 *
 * Two passes, which is the standard resolution of the chicken-and-egg between
 * a wall clock and its offset: guess with the offset that applies to the same
 * wall clock read as UTC, then correct with the offset that actually applies
 * to the resulting instant. Ecuador never needs the second pass; a zone with
 * daylight saving does, and the test asserts it.
 */
export function atWallClock(
  date: ClinicalDate,
  time: WallClockTime,
  timeZone: string = CLINIC_TIME_ZONE,
): Date {
  const [year, month, day] = parseClinicalDate(date)
    .split('-')
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];

  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    time.second,
  );

  const guessOffset = zoneOffsetMinutes(new Date(asUtc), timeZone);
  const guess = asUtc - guessOffset * MS_PER_MINUTE;
  const actualOffset = zoneOffsetMinutes(new Date(guess), timeZone);

  return new Date(
    actualOffset === guessOffset ? guess : asUtc - actualOffset * MS_PER_MINUTE,
  );
}

/**
 * The wall clock `timeZone` shows at that instant: the inverse of
 * `atWallClock`, and the only honest way to name an instant to a user. Saying
 * "13:10" for an appointment the receptionist books at 08:10 is how a UTC
 * timestamp leaks into a Spanish sentence.
 */
export function wallClockOf(
  instant: Date,
  timeZone: string = CLINIC_TIME_ZONE,
): WallClockTime {
  const offset = zoneOffsetMinutes(instant, timeZone);
  const local = new Date(instant.getTime() + offset * MS_PER_MINUTE);
  return WallClockTime.of(
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  );
}

/**
 * The instant a calendar date begins in `timeZone`.
 *
 * WHAT A DATE BECOMES WHEN IT HAS TO BE STORED AS AN INSTANT. A date of death
 * is what the person at the desk knows — "murió el 3 de marzo" — while
 * `patient.deceased_at` is a `timestamptz`, so somebody has to decide which
 * moment that date is. Midnight IN ECUADOR, never midnight UTC: the latter is
 * 19:00 of the previous day here, which pushes the death a day earlier than
 * recorded and can make it precede a birth on the same date.
 */
export function startOfClinicalDay(
  date: ClinicalDate,
  timeZone: string = CLINIC_TIME_ZONE,
): Date {
  return atWallClock(date, WallClockTime.fromMinutes(0), timeZone);
}

/**
 * The half-open bounds of a clinical day, `[startsAt, endsAtExclusive)`.
 *
 * Half-open because that is what `tstzrange(…, '[)')` uses in the exclusion
 * constraints: an appointment starting exactly at midnight belongs to the day
 * that begins, and to only one day.
 */
export function clinicalDayBounds(
  date: ClinicalDate,
  timeZone: string = CLINIC_TIME_ZONE,
): { startsAt: Date; endsAtExclusive: Date } {
  return {
    startsAt: startOfClinicalDay(date, timeZone),
    endsAtExclusive: startOfClinicalDay(addDays(date, 1), timeZone),
  };
}

/** ISO-8601 weekday, 1 = Monday … 7 = Sunday. The numbering the rules use. */
export function isoWeekdayOf(date: ClinicalDate): number {
  const utc = new Date(`${parseClinicalDate(date)}T00:00:00Z`);
  // `getUTCDay()` is 0 = Sunday; the rules are ISO-8601.
  return utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
}

/** Calendar arithmetic on the date itself, with no zone involved. */
export function addDays(date: ClinicalDate, days: number): ClinicalDate {
  const utc = new Date(`${parseClinicalDate(date)}T00:00:00Z`);
  return new Date(utc.getTime() + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10) as ClinicalDate;
}

/**
 * How many dates the inclusive range covers; `0` when `to` precedes `from`.
 *
 * Counted on the calendar and not in hours: no zone is involved, so a day that
 * lasts 23 or 25 hours somewhere still counts as one date.
 */
export function clinicalDaySpan(from: ClinicalDate, to: ClinicalDate): number {
  const first = new Date(`${parseClinicalDate(from)}T00:00:00Z`).getTime();
  const last = new Date(`${parseClinicalDate(to)}T00:00:00Z`).getTime();
  if (last < first) return 0;
  return Math.round((last - first) / MS_PER_DAY) + 1;
}

/** Every date from `from` to `to`, both included. Empty if `to` precedes `from`. */
export function clinicalDatesBetween(
  from: ClinicalDate,
  to: ClinicalDate,
): ClinicalDate[] {
  const span = clinicalDaySpan(from, to);
  if (span === 0) return [];

  if (span > MAX_RANGE_DAYS) {
    throw new RangeError(
      `Date range spans ${span} days, more than the ${MAX_RANGE_DAYS} allowed`,
    );
  }

  return Array.from({ length: span }, (_, index) => addDays(from, index));
}

/**
 * A time of day with no date and no zone attached: "Mondays at 08:00".
 *
 * This is what `practitioner_schedule_rule.start_time` holds, the one
 * deliberate exception to the timestamptz convention. Keeping it a distinct
 * type is what stops it being compared against an instant by accident.
 */
export class WallClockTime {
  private constructor(
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
  ) {
    Object.freeze(this);
  }

  static parse(value: string): WallClockTime {
    const match = TIME_PATTERN.exec(value);
    if (!match) {
      throw new RangeError(`Wall clock must be HH:MM or HH:MM:SS: ${value}`);
    }
    const [, hour, minute, second] = match;
    return WallClockTime.of(
      Number.parseInt(hour ?? '', 10),
      Number.parseInt(minute ?? '', 10),
      second === undefined ? 0 : Number.parseInt(second, 10),
    );
  }

  static of(hour: number, minute: number, second = 0): WallClockTime {
    const valid =
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      Number.isInteger(second) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59 &&
      second >= 0 &&
      second <= 59;

    if (!valid) {
      throw new RangeError(
        `Wall clock is not a time of day: ${hour}:${minute}:${second}`,
      );
    }
    return new WallClockTime(hour, minute, second);
  }

  static fromMinutes(minutesFromMidnight: number): WallClockTime {
    if (
      !Number.isInteger(minutesFromMidnight) ||
      minutesFromMidnight < 0 ||
      minutesFromMidnight >= MINUTES_PER_DAY
    ) {
      throw new RangeError(
        `Wall clock outside the day: ${minutesFromMidnight} minutes`,
      );
    }
    return new WallClockTime(
      Math.floor(minutesFromMidnight / 60),
      minutesFromMidnight % 60,
      0,
    );
  }

  /**
   * Reads a `time` column as the driver hands it over: a `Date` pinned to
   * 1970-01-01 whose UTC components ARE the wall clock. Local getters would
   * shift the rule by the host offset, which is the bug this exists to avoid.
   */
  static fromTimeColumn(value: Date): WallClockTime {
    // PostgreSQL accepts `'24:00'` in a `time` column, and the driver hands it
    // over as a Date rolled into 1970-01-02T00:00Z. Reading the UTC parts
    // would SILENTLY turn "until midnight" into "since midnight" — a rule
    // inverted, not rejected. The `schedule_rule_*` CHECKs keep such rows out
    // of the database; this guard keeps the silent inversion impossible even
    // if the value arrives from somewhere else.
    if (value.getTime() >= MS_PER_DAY) {
      throw new RangeError(
        `time column value rolls past midnight: ${value.toISOString()}`,
      );
    }
    return WallClockTime.of(
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
    );
  }

  get minutesFromMidnight(): number {
    return this.hour * 60 + this.minute;
  }

  get secondsFromMidnight(): number {
    return this.minutesFromMidnight * 60 + this.second;
  }

  plusMinutes(minutes: number): WallClockTime {
    return WallClockTime.fromMinutes(this.minutesFromMidnight + minutes);
  }

  isBefore(other: WallClockTime): boolean {
    return this.secondsFromMidnight < other.secondsFromMidnight;
  }

  /** `HH:MM`, with seconds only when they carry information. */
  toString(): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const base = `${pad(this.hour)}:${pad(this.minute)}`;
    return this.second === 0 ? base : `${base}:${pad(this.second)}`;
  }
}
