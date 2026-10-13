import type {
  HistoryResult,
  HistoryVisit,
  PrescribedLine,
} from '../domain/clinical-history';

/** The caller's sites for `record:read`; `'all'` is the whole clinic. */
export type HistorySites = 'all' | readonly string[];

/**
 * AS-200. What every read asks: the chart (and, through `chartScope`, the
 * charts it absorbed), inside the caller's sites, never an annulled
 * attention's.
 */
export interface ClinicalHistoryQuery {
  patientId: string;
  sites: HistorySites;
}

/** AS-200 to AS-207. The record, read; nothing here writes. */
export interface ClinicalHistoryReader {
  /** AS-200. The chart exists and was not absorbed by a merge. */
  chartIsOpen(patientId: string): Promise<boolean>;
  /** AS-201. Results of current reports of issued laboratory orders, newest first. */
  results(query: ClinicalHistoryQuery, limit: number): Promise<HistoryResult[]>;
  /** The same `where` as `results`, so «300 de 412» reconciles. */
  countResults(query: ClinicalHistoryQuery): Promise<number>;
  /** AS-203. The lines of the `limit` most recent issued prescriptions. */
  prescribedLines(
    query: ClinicalHistoryQuery,
    limit: number,
  ): Promise<PrescribedLine[]>;
  countPrescriptions(query: ClinicalHistoryQuery): Promise<number>;
  /** AS-205. The attentions, newest first. */
  visits(query: ClinicalHistoryQuery, limit: number): Promise<HistoryVisit[]>;
  countVisits(query: ClinicalHistoryQuery): Promise<number>;
  /**
   * AS-200. Attentions exist at sites the caller does not cover: whether,
   * never how many (EN-121, D-214 §5). With every site in scope, `false`.
   */
  hasVisitsOutsideScope(query: ClinicalHistoryQuery): Promise<boolean>;
}

export const CLINICAL_HISTORY_READER = Symbol('CLINICAL_HISTORY_READER');
export const CLINICAL_HISTORY_CLOCK = Symbol('CLINICAL_HISTORY_CLOCK');
