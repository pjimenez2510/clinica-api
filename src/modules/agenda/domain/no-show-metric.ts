/**
 * AG-080, AG-081. The inasistencia rate: who did not turn up, over what.
 *
 * PURE, AND IT IS THE POINT. The database is very good at turning a million
 * appointments into a few dozen counted cells; it is a terrible place to keep
 * the rule about WHICH cells count, because a `WHERE status <> 'CANCELLED'`
 * buried in a query is a copy of AG-081 that no test can name. So the adapter
 * returns the cube — site · practitioner · channel · status, counted — and
 * everything that decides the numerator, the denominator and the division
 * happens here, where a test can break it.
 *
 * THE CUBE DOES NOT GROW WITH THE CLINIC'S HISTORY. Its size is
 * sites × practitioners × 4 channels × 10 statuses, so a year of appointments
 * and a day of them cross the wire the same way. That is what makes «count in
 * SQL, decide in the domain» affordable rather than a purity tax.
 */

import {
  CLINIC_TIME_ZONE,
  type ClinicalDate,
  addDays,
  clinicalDayBounds,
} from '../../../shared/domain/clinic-time';

import type { AgendaEntryStatus } from './agenda-entry';
import { BOOKING_CHANNELS, type BookingChannel } from './booking-policy';

/**
 * AG-081 first clause, and AG-140 third. What leaves the calculation entirely.
 *
 * `CANCELLED`: an annulled appointment is not an absence — nobody was
 * expected. A rescheduled original is annulled too (AG-050), so this single
 * exclusion is also what stops «recepción movió la hora» being reported as
 * «el paciente no vino».
 *
 * `ENTERED_IN_ERROR` (AG-140): the appointment did not happen and never
 * existed. Leaving it in the denominator would measure the clinic over
 * imaginary patients. IT IS ALSO NOT AN ANNULMENT, which is the other figure
 * that used to come out wrong: AG-081 drops the `CANCELLED` rows without
 * asking why they were cancelled, so before this status existed an afternoon
 * of typing mistakes read as an afternoon in which the clinic cancelled on its
 * patients.
 */
const EXCLUDED_STATUSES: readonly AgendaEntryStatus[] = [
  'CANCELLED',
  'ENTERED_IN_ERROR',
];

/** The status that IS the absence (AG-042). */
const NO_SHOW_STATUS: AgendaEntryStatus = 'NO_SHOW';

/**
 * AG-116, AG-140. The patient who came, waited and left before being seen.
 *
 * IN THE DENOMINATOR, OUT OF THE NUMERATOR, AND COUNTED ON ITS OWN — the three
 * halves are the requirement, and they are why this is a second status rather
 * than a flag on `NO_SHOW`. They HAD an appointment and they DID reach their
 * hour, so taking them out of the denominator would shrink the total the rate
 * is measured over and improve the clinic's figure for the sole reason that
 * people got tired of waiting. And the count travels beside the rate because
 * that is what the user asked this for: A METRIC THAT CAN BE REDUCED. A number
 * nobody can see is a number nobody works on.
 */
const LEFT_WITHOUT_BEING_SEEN_STATUS: AgendaEntryStatus =
  'LEFT_WITHOUT_BEING_SEEN';

/**
 * The statuses that state an outcome. Everything else in the denominator is an
 * appointment whose hour passed and that nobody closed — see `pending`.
 *
 * `LEFT_WITHOUT_BEING_SEEN` IS ONE OF THEM: somebody recorded what happened,
 * which is the whole difference between this status and the silence of an
 * appointment nobody closed. Counting it as `pending` would say the outcome is
 * unknown when it is precisely known.
 */
const RESOLVED_STATUSES: readonly AgendaEntryStatus[] = [
  'FULFILLED',
  'NO_SHOW',
  'LEFT_WITHOUT_BEING_SEEN',
];

/**
 * Four decimals: one hundredth of a percentage point.
 *
 * 1/3 served raw arrives as `0.3333333333333333`, and then every client rounds
 * it its own way — which is how the same rate ends up printed differently on
 * two screens of the same system.
 */
const RATE_DECIMALS = 4;

/** The half-open span of instants the metric is computed over. */
export interface NoShowWindow {
  from: Date;
  untilExclusive: Date;
}

/**
 * One counted cell of the cube the adapter returns.
 *
 * The names travel with the identifiers because the report is READ by a
 * person, and a second call to resolve forty ids is a second answer that can
 * disagree with the first. Nothing about a PATIENT is here — the metric counts
 * appointments, and who missed one is a different question with a different
 * permission (AG-072, AG-074).
 */
export interface NoShowCountRow {
  siteId: string;
  siteName: string;
  practitionerId: string;
  practitionerName: string;
  /** Never `null` on an appointment: `agenda_entry_booking_channel_coherence`. */
  bookingChannel: BookingChannel;
  status: AgendaEntryStatus;
  count: number;
}

/** A rate and the two numbers it is made of. Never the rate alone. */
export interface NoShowRate {
  /** AG-080, the numerator: appointments marked `NO_SHOW`. */
  noShow: number;
  /**
   * AG-140. Of `total`, those who came and left before being seen.
   *
   * NOT PART OF `noShow` AND NOT SUBTRACTED FROM `total`. It is served beside
   * the rate, with the same three breakdowns, because it is the number the
   * clinic acts on: waiting times are the only cause it has, and unlike the
   * absences it is entirely the establishment's to fix.
   */
  leftWithoutBeingSeen: number;
  /** AG-081, the denominator: reached their hour and were not annulled. */
  total: number;
  /**
   * Of `total`, those with no outcome recorded — still `BOOKED`, `CONFIRMED`,
   * `CHECKED_IN` or `IN_PROGRESS` after their hour passed.
   *
   * IT IS SERVED BECAUSE THE RATE IS UNREADABLE WITHOUT IT. AG-081 puts these
   * in the denominator, which is the honest reading of «las que alcanzaron su
   * hora de inicio» — and it means a clinic that stops marking absences sees
   * its own figure improve. Publishing how many appointments the number is
   * guessing about is what keeps that visible instead of silent.
   */
  pending: number;
  /**
   * `noShow / total`, or `null` when `total` is zero.
   *
   * NOT `0`. Zero per cent says «nadie faltó»; this says «no hubo a quién
   * faltar», and reporting the first for the second describes a clinic
   * behaving perfectly on a day it never opened.
   */
  rate: number | null;
}

export interface NoShowBySite extends NoShowRate {
  siteId: string;
  siteName: string;
}

export interface NoShowByPractitioner extends NoShowRate {
  practitionerId: string;
  practitionerName: string;
}

export interface NoShowByChannel extends NoShowRate {
  bookingChannel: BookingChannel;
}

/**
 * AG-080. One calculation, three cuts of it, and the whole.
 *
 * THE THREE TRAVEL TOGETHER on purpose, the same argument the availability
 * answer makes: a client that had to ask three times would paint three panels
 * computed over three different instants of «now», and they would not add up.
 */
export interface NoShowReport {
  overall: NoShowRate;
  bySite: NoShowBySite[];
  byPractitioner: NoShowByPractitioner[];
  byChannel: NoShowByChannel[];
}

/**
 * AG-001, AG-081. The instants the range covers, in Ecuador, ending no later
 * than now.
 *
 * TWO RULES IN ONE FUNCTION, and they belong together. The Ecuadorian bounds
 * are AG-001 — read in UTC, an appointment at 19:30 on the last day of the
 * range falls into the next one and the evening figures are reported against a
 * month they do not belong to. The truncation at `now` is the second clause of
 * AG-081: an appointment that has not started cannot have been missed, so
 * counting it would dilute every rate asked over a range that reaches into
 * next week.
 *
 * The result is NEVER inverted: a range entirely in the future comes back
 * empty (`untilExclusive === from`) rather than backwards, because what an
 * adapter does with a backwards range is its own business and none of it is
 * this metric's answer.
 */
export function noShowWindow(
  from: ClinicalDate,
  to: ClinicalDate,
  now: Date,
  timeZone: string = CLINIC_TIME_ZONE,
): NoShowWindow {
  const start = clinicalDayBounds(from, timeZone).startsAt;
  // The day AFTER `to` at midnight: the range is inclusive of `to`, and the
  // window is half-open exactly like `tstzrange(…, '[)')`.
  const end = clinicalDayBounds(addDays(to, 1), timeZone).startsAt;

  const cappedByNow = Math.min(end.getTime(), now.getTime());

  return {
    from: start,
    untilExclusive: new Date(Math.max(start.getTime(), cappedByNow)),
  };
}

/**
 * AG-080, AG-081. The cube, reduced to the report.
 *
 * Everything AG-081 excludes is dropped HERE and not in the query: the cells
 * arrive including the annulled ones, and the test that names the requirement
 * fails if this stops discarding them. The alternative — a `WHERE` clause —
 * would pass every test in this file while excluding nothing at all.
 */
export function summariseNoShow(rows: readonly NoShowCountRow[]): NoShowReport {
  const counted = rows.filter((row) => !EXCLUDED_STATUSES.includes(row.status));

  return {
    overall: rateOf(counted),
    bySite: groupBy(
      counted,
      (row) => row.siteId,
      (row) => ({ siteId: row.siteId, siteName: row.siteName }),
    ).sort((a, b) => a.siteName.localeCompare(b.siteName, 'es')),
    byPractitioner: groupBy(
      counted,
      (row) => row.practitionerId,
      (row) => ({
        practitionerId: row.practitionerId,
        practitionerName: row.practitionerName,
      }),
    ).sort((a, b) =>
      a.practitionerName.localeCompare(b.practitionerName, 'es'),
    ),
    byChannel: groupBy(
      counted,
      (row) => row.bookingChannel,
      (row) => ({ bookingChannel: row.bookingChannel }),
    ).sort(
      (a, b) =>
        // AG-034's order, not the alphabet: it is the order the requirement
        // enumerates them in, and the server decides it so two screens cannot
        // present the same four channels differently.
        BOOKING_CHANNELS.indexOf(a.bookingChannel) -
        BOOKING_CHANNELS.indexOf(b.bookingChannel),
    ),
  };
}

/**
 * The cells of one group, added up.
 *
 * A group whose appointments were ALL annulled disappears instead of arriving
 * as «0 de 0»: `counted` is already empty for it, so it never gets a key.
 */
function groupBy<T>(
  rows: readonly NoShowCountRow[],
  keyOf: (row: NoShowCountRow) => string,
  labelOf: (row: NoShowCountRow) => T,
): (T & NoShowRate)[] {
  const groups = new Map<string, { label: T; rows: NoShowCountRow[] }>();

  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { label: labelOf(row), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group.label,
    ...rateOf(group.rows),
  }));
}

/** AG-080. The division, and the two numbers that justify it. */
function rateOf(rows: readonly NoShowCountRow[]): NoShowRate {
  const sum = (predicate: (row: NoShowCountRow) => boolean): number =>
    rows.filter(predicate).reduce((running, row) => running + row.count, 0);

  const total = sum(() => true);
  const noShow = sum((row) => row.status === NO_SHOW_STATUS);
  const leftWithoutBeingSeen = sum(
    (row) => row.status === LEFT_WITHOUT_BEING_SEEN_STATUS,
  );
  const pending = sum((row) => !RESOLVED_STATUSES.includes(row.status));

  return {
    noShow,
    leftWithoutBeingSeen,
    total,
    pending,
    // AG-140: the numerator is `noShow` ALONE. Whoever left without being seen
    // stays in `total` and never here — they came.
    rate: total === 0 ? null : round(noShow / total),
  };
}

function round(value: number): number {
  const factor = 10 ** RATE_DECIMALS;
  return Math.round(value * factor) / factor;
}
