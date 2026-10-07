import { arrivalDelayMinutes } from './late-arrival';

/**
 * AG-141. Late arrival over a range, by site and practitioner: the median
 * delay, how many arrivals ran past their site's threshold, and over how many.
 *
 * NOTHING HERE IS TYPED. Every number comes from two `timestamptz` of the row
 * (AG-118) and the site's current threshold (AG-142), which is what keeps it
 * true without anybody remembering anything.
 *
 * THE MEDIAN AND NOT THE MEAN: a patient who came three hours early — or three
 * hours late and was seen anyway — drags a mean and does not move a median.
 * And the denominator always travels: «el 40 % llegó tarde» over five
 * appointments and over four hundred is the same number and not the same fact.
 */

/** One arrival, as the repository reads it. */
export interface LateArrivalRow {
  siteId: string;
  siteName: string;
  practitionerId: string;
  practitionerName: string;
  startsAt: Date;
  checkedInAt: Date;
  /** The site's CURRENT threshold: how many would be late under today's policy. */
  graceMinutes: number;
}

export interface LateArrivalFigures {
  /** Arrivals counted: the denominator. */
  arrivals: number;
  /** Of them, those whose delay exceeded their site's threshold. */
  late: number;
  /** Whole minutes, signed (negative is early); `null` with no arrivals. */
  medianDelayMinutes: number | null;
}

export interface LateArrivalReport {
  overall: LateArrivalFigures;
  bySite: (LateArrivalFigures & { siteId: string; siteName: string })[];
  byPractitioner: (LateArrivalFigures & {
    practitionerId: string;
    practitionerName: string;
  })[];
}

/** The median of whole minutes, rounded to a whole minute; `null` if empty. */
export function medianMinutes(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function figuresOf(rows: readonly LateArrivalRow[]): LateArrivalFigures {
  const delays = rows.map(
    (row) =>
      arrivalDelayMinutes({
        startsAt: row.startsAt,
        checkedInAt: row.checkedInAt,
      }) ?? 0,
  );
  return {
    arrivals: rows.length,
    // The same comparison as the warning at the counter (AG-119): strictly
    // past the threshold.
    late: rows.filter((row, index) => delays[index]! > row.graceMinutes).length,
    medianDelayMinutes: medianMinutes(delays),
  };
}

function groupBy<K extends string>(
  rows: readonly LateArrivalRow[],
  key: (row: LateArrivalRow) => K,
): Map<K, LateArrivalRow[]> {
  const groups = new Map<K, LateArrivalRow[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

/**
 * AG-141. The three cuts of the SAME set, computed together: asked
 * separately they would be computed over three «now» and would not add up.
 * Sites and practitioners in name order, as the no-show report (AG-080).
 */
export function summariseLateArrival(
  rows: readonly LateArrivalRow[],
): LateArrivalReport {
  const bySite = [...groupBy(rows, (row) => row.siteId).values()]
    .map((group) => ({
      siteId: group[0]!.siteId,
      siteName: group[0]!.siteName,
      ...figuresOf(group),
    }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName, 'es'));
  const byPractitioner = [
    ...groupBy(rows, (row) => row.practitionerId).values(),
  ]
    .map((group) => ({
      practitionerId: group[0]!.practitionerId,
      practitionerName: group[0]!.practitionerName,
      ...figuresOf(group),
    }))
    .sort((a, b) => a.practitionerName.localeCompare(b.practitionerName, 'es'));
  return { overall: figuresOf(rows), bySite, byPractitioner };
}
