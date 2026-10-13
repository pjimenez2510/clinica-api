/**
 * AS-260 to AS-265. What the assistant needs of the chart's allergies and
 * history to propose them as records, for the module that does not own
 * `patient_allergy`, `patient_allergy_absence` nor `patient_history`.
 *
 * ⚠️ IT READS AND IT NEVER WRITES. Recording is a use case of `encounter`,
 * with its route, permission, validations and author (EN-080, EN-085,
 * EN-087): the physician's ✓ goes there, and only then is the proposal
 * linked (P1).
 */

/** EN-085. A live entry of the chart's history, as it is compared. */
export interface ChartHistoryEntry {
  kind: 'PERSONAL' | 'FAMILY';
  description: string;
  relative: string | null;
}

/** The record a proposal of the chart is linked to, as AS-265 checks it. */
export interface ChartRecord {
  patientId: string;
  /** Who recorded or asserted it; null only on rows older than EN-086. */
  authorId: string | null;
  recordedAt: Date;
  /** Refuted or retracted since: no longer what the chart says. */
  withdrawn: boolean;
  /** `chartRecordText` of the record: what a proposal is compared with (AS-022). */
  text: string;
}

export type ChartRecordKind = 'allergy' | 'absence' | 'history';

export interface ChartBackgroundReader {
  /** EN-085. The chart's unrefuted history entries. */
  activeHistory(chartId: string): Promise<readonly ChartHistoryEntry[]>;
  /**
   * D-169.2. The chart a record of this one is written on: the one that
   * absorbed it after a merge, or itself — where the screen records (EN-238).
   */
  survivorOf(chartId: string): Promise<string>;
  /** AS-265. A record of the chart, or null when there is none with that id. */
  record(kind: ChartRecordKind, id: string): Promise<ChartRecord | null>;
}

export const CHART_BACKGROUND_READER = Symbol('ChartBackgroundReader');

/** AS-261. «Sin alergias conocidas», as the chart says it. */
export const NO_KNOWN_ALLERGIES = 'Sin alergias conocidas';

/**
 * AS-022, AS-261. A record of the chart as one line: what the proposal shows
 * and what its acceptance is compared with. «Amoxicilina · ronchas»,
 * «Hipertensión arterial · Madre», «Sin alergias conocidas».
 */
export function chartRecordText(
  record:
    | { kind: 'allergy'; substance: string; reaction: string | null }
    | { kind: 'absence' }
    | { kind: 'history'; description: string; relative: string | null },
): string {
  const join = (...parts: (string | null)[]) =>
    parts
      .map((part) => part?.trim() ?? '')
      .filter((part) => part !== '')
      .join(' · ');
  if (record.kind === 'absence') return NO_KNOWN_ALLERGIES;
  if (record.kind === 'allergy') return join(record.substance, record.reaction);
  return join(record.description, record.relative);
}
