import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

/**
 * AS-200 to AS-207. THE PATIENT'S HISTORY WITHOUT A MODEL (B1).
 *
 * Adapted from SigmAI `modules/history/timeline.ts` (E-066: P95 12 ms). Two
 * things it did are NOT here, on purpose:
 *
 *  - `reference-range.ts` read a range out of the laboratory's free text.
 *    Here every result keeps the range and the flag it was reported with,
 *    structured and frozen (ORD-037, ORD-122): they are shown as they are, and
 *    that is what makes the figures the same as the report's (SC-098).
 *  - its timeline stopped a drug when a later prescription left it out. Here a
 *    course ends by the days its prescription states (AS-204, D-256 §2): the
 *    prescription for a cold does not stop the enalapril.
 */

/** The flag the report stored (`abnormal_flag`); `null` is «no range», never normal. */
export type HistoryFlag =
  'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH';

/** AS-201. One result of a current report, with what the report froze. */
export interface HistoryResult {
  /** `observation_result.id`, a bigint, as text. */
  id: string;
  orderId: string;
  encounterId: string;
  analyteConceptId: string | null;
  analyteDisplay: string;
  valueNumeric: number | null;
  valueText: string | null;
  valueCode: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  abnormalFlag: HistoryFlag | null;
  observedAt: Date;
  /** EN-275. Recorded on a chart this one absorbed. */
  fromMergedChart: boolean;
}

/** AS-203. One line of an issued prescription. */
export interface PrescribedLine {
  prescriptionId: string;
  encounterId: string;
  issuedAt: Date;
  conceptId: string | null;
  genericName: string;
  concentration: string | null;
  presentation: string | null;
  doseText: string;
  frequencyText: string;
  durationDays: number | null;
  fromMergedChart: boolean;
}

/** AS-205. One attention, as the timeline writes it. */
export interface HistoryVisit {
  encounterId: string;
  startedAt: Date;
  /** EN-163, taken in preparation; `null` is written «Consulta». */
  presentingComplaint: string | null;
  siteName: string;
  /** Its current diagnoses, by rank. */
  diagnoses: readonly { code: string; display: string }[];
  fromMergedChart: boolean;
}

/** AS-204. Active, ended, or impossible to tell. */
export type MedicationStatus = 'ACTIVE' | 'ENDED' | 'NO_DURATION';

/** AS-203. A medicine, once, however many times it was prescribed. */
export interface Medication {
  key: string;
  genericName: string;
  concentration: string | null;
  presentation: string | null;
  lastDoseText: string;
  lastFrequencyText: string;
  timesPrescribed: number;
  firstPrescribedOn: ClinicalDate;
  lastPrescribedOn: ClinicalDate;
  /** The last day any of its courses reaches; `null` with `NO_DURATION`. */
  endsOn: ClinicalDate | null;
  status: MedicationStatus;
  lastPrescriptionId: string;
  fromMergedChart: boolean;
}

export type TimelineItem =
  | {
      kind: 'visit';
      encounterId: string;
      complaint: string | null;
      diagnoses: readonly { code: string; display: string }[];
      siteName: string;
      fromMergedChart: boolean;
    }
  | {
      kind: 'medication-started' | 'medication-ended';
      medicationKey: string;
      name: string;
    }
  | { kind: 'result'; resultId: string; orderId: string };

export interface TimelineDay {
  date: ClinicalDate;
  items: TimelineItem[];
}

/** AS-205. Within a day: the visit, then what began, what ended, what came back. */
const ITEM_ORDER: Record<TimelineItem['kind'], number> = {
  visit: 0,
  'medication-started': 1,
  'medication-ended': 2,
  result: 3,
};

const OUT_OF_RANGE: ReadonlySet<HistoryFlag> = new Set([
  'LOW',
  'HIGH',
  'CRITICAL_LOW',
  'CRITICAL_HIGH',
]);

/**
 * AS-205, D-256 §2. A prescription issued up to a week after the last day of
 * the previous one is a RENEWAL of the same treatment, not a stop and a new
 * start: the monthly enalapril picked up a day late would otherwise write
 * «Termina» and «Empieza» every month and bury what did change.
 */
export const RENEWAL_GRACE_DAYS = 7;

const STATUS_ORDER: Record<MedicationStatus, number> = {
  ACTIVE: 0,
  NO_DURATION: 1,
  ENDED: 2,
};

const normalised = (text: string | null): string =>
  (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * AS-203. The CNMB concept when the line has one; otherwise the generic name
 * and the concentration, so 500 mg and 850 mg of metformin stay apart.
 */
export function medicationKeyOf(line: PrescribedLine): string {
  return line.conceptId
    ? `concept:${line.conceptId}`
    : `name:${normalised(line.genericName)}|${normalised(line.concentration)}`;
}

/**
 * AS-206. The series a numeric result belongs to: its catalogue
 * determination (or its name) WITH its unit — glucose in mg/dL and in mmol/L
 * are two curves, never one. A result that is not a number draws nothing.
 */
export function seriesKeyOf(result: HistoryResult): string | null {
  if (result.valueNumeric === null) return null;
  const analyte = result.analyteConceptId
    ? `concept:${result.analyteConceptId}`
    : `name:${normalised(result.analyteDisplay)}`;
  return `${analyte}|${normalised(result.unit)}`;
}

/** The first day after which the course is over: issue day + days − 1. */
const lastDayOf = (line: PrescribedLine): ClinicalDate | null =>
  line.durationDays === null || line.durationDays < 1
    ? null
    : addDays(clinicalDateOf(line.issuedAt), line.durationDays - 1);

const byIssue = (a: PrescribedLine, b: PrescribedLine): number =>
  a.issuedAt.getTime() - b.issuedAt.getTime();

function groupLines(
  lines: readonly PrescribedLine[],
): Map<string, PrescribedLine[]> {
  const groups = new Map<string, PrescribedLine[]>();
  for (const line of [...lines].sort(byIssue)) {
    const key = medicationKeyOf(line);
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  return groups;
}

/**
 * AS-203, AS-204. Each medicine once, with whether it is still being taken.
 *
 * `endsOn` is the furthest day any course reaches, so a five-day course
 * written while a thirty-day one runs does not end it early. With no days on
 * the LAST prescription nothing can be said: neither active nor ended.
 */
export function medicationsOf(
  lines: readonly PrescribedLine[],
  today: ClinicalDate,
): Medication[] {
  const medicines: Medication[] = [];
  for (const [key, group] of groupLines(lines)) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const ends = group
      .map(lastDayOf)
      .filter((end): end is ClinicalDate => end !== null);
    const endsOn =
      lastDayOf(last) === null ? null : ends.reduce((a, b) => (a > b ? a : b));
    const status: MedicationStatus =
      endsOn === null ? 'NO_DURATION' : today <= endsOn ? 'ACTIVE' : 'ENDED';

    medicines.push({
      key,
      genericName: last.genericName.trim(),
      concentration: last.concentration,
      presentation: last.presentation,
      lastDoseText: last.doseText,
      lastFrequencyText: last.frequencyText,
      timesPrescribed: new Set(group.map((line) => line.prescriptionId)).size,
      firstPrescribedOn: clinicalDateOf(first.issuedAt),
      lastPrescribedOn: clinicalDateOf(last.issuedAt),
      endsOn,
      status,
      lastPrescriptionId: last.prescriptionId,
      fromMergedChart: group.some((line) => line.fromMergedChart),
    });
  }

  return medicines.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.lastPrescribedOn.localeCompare(a.lastPrescribedOn) ||
      a.genericName.localeCompare(b.genericName),
  );
}

const nameOf = (line: PrescribedLine): string =>
  line.concentration
    ? `${line.genericName.trim()} ${line.concentration.trim()}`
    : line.genericName.trim();

/**
 * AS-205. The history as dated lines, built from the record and nothing else.
 *
 * A medicine is written the day it starts and the day it ends; renewed before
 * its end, or within `RENEWAL_GRACE_DAYS` of it, it simply goes on. A course with no days goes on until a later one
 * says otherwise — and writes no end. Only results out of range: the rest are
 * in «Laboratorio», and a timeline of normal glucoses hides the high one.
 */
export function timelineOf(input: {
  visits: readonly HistoryVisit[];
  lines: readonly PrescribedLine[];
  results: readonly HistoryResult[];
  today: ClinicalDate;
}): TimelineDay[] {
  const days = new Map<ClinicalDate, TimelineItem[]>();
  const add = (date: ClinicalDate, item: TimelineItem): void => {
    const items = days.get(date) ?? [];
    items.push(item);
    days.set(date, items);
  };

  for (const visit of input.visits) {
    add(clinicalDateOf(visit.startedAt), {
      kind: 'visit',
      encounterId: visit.encounterId,
      complaint: visit.presentingComplaint?.trim() || null,
      diagnoses: visit.diagnoses,
      siteName: visit.siteName,
      fromMergedChart: visit.fromMergedChart,
    });
  }

  for (const [key, group] of groupLines(input.lines)) {
    // `undefined`: not started yet; `null`: running with no known end.
    let runningEnd: ClinicalDate | null | undefined;
    for (const line of group) {
      const issued = clinicalDateOf(line.issuedAt);
      if (
        runningEnd !== undefined &&
        runningEnd !== null &&
        addDays(runningEnd, RENEWAL_GRACE_DAYS) < issued
      ) {
        add(runningEnd, { kind: 'medication-ended', medicationKey: key, name: nameOf(line) }); // prettier-ignore
        runningEnd = undefined;
      }
      if (runningEnd === undefined) {
        add(issued, { kind: 'medication-started', medicationKey: key, name: nameOf(line) }); // prettier-ignore
      }
      const end = lastDayOf(line);
      runningEnd =
        end === null
          ? null
          : runningEnd === undefined || runningEnd === null || end > runningEnd
            ? end
            : runningEnd;
    }
    if (
      runningEnd !== undefined &&
      runningEnd !== null &&
      runningEnd < input.today
    ) {
      add(runningEnd, { kind: 'medication-ended', medicationKey: key, name: nameOf(group[group.length - 1]!) }); // prettier-ignore
    }
  }

  for (const result of input.results) {
    if (result.abnormalFlag !== null && OUT_OF_RANGE.has(result.abnormalFlag)) {
      add(clinicalDateOf(result.observedAt), {
        kind: 'result',
        resultId: result.id,
        orderId: result.orderId,
      });
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, items]) => ({
      date,
      // Stable: within one kind, the order they were added in.
      items: items
        .map((item, index) => ({ item, index }))
        .sort(
          (a, b) =>
            ITEM_ORDER[a.item.kind] - ITEM_ORDER[b.item.kind] ||
            a.index - b.index,
        )
        .map(({ item }) => item),
    }));
}
