import type { HeightPosition } from './vital-signs';
import type { SiteScopeFilter } from './encounter.repository';

/**
 * EN-269 to EN-272. The vital-sign takings of a chart, as the «Evolución» tab
 * draws them.
 *
 * A READ MODEL OF ITS OWN and not a method of `ChartSummaryRepository`: the
 * summary is addressed by the attention being conducted and bounded at five,
 * this is addressed by the chart and bounded at a hundred, and the two change
 * for different reasons (ADR-008 §2).
 */
export interface VitalsHistoryQuery {
  /**
   * The chart. The adapter reads it AND the charts it absorbed (PA-055): a
   * weight recorded on the duplicate is the same person's weight.
   */
  patientId: string;
  /** EN-121. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  /** How many takings come back, newest first. A bound, not a page. */
  limit: number;
}

/** EN-269. One taking: every figure of block D, and the age of that day. */
export interface VitalsTaking {
  encounterId: string;
  siteId: string;
  measuredAt: Date;
  /**
   * EN-221, EN-008. The age FROZEN on the attention, never recomputed from
   * today's birth date: a corrected birth date must not move a 2024 point.
   */
  ageYears: number | null;
  ageMonths: number | null;
  ageDays: number | null;
  weightKg: number | null;
  heightCm: number | null;
  heightPosition: HeightPosition | null;
  headCircumferenceCm: number | null;
  abdominalCircumferenceCm: number | null;
  /** EN-061. The figure the trigger stored, never one derived here. */
  bmi: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperatureC: number | null;
  oxygenSaturation: number | null;
  hemoglobinGDl: number | null;
  hemoglobinCorrectedGDl: number | null;
  /**
   * EN-275. The attention belongs to a chart the asked one ABSORBED: its age
   * was frozen with the duplicate's birth date, which may have been wrong.
   */
  fromMergedChart: boolean;
}

/** EN-272. The blood-pressure line the charts draw, in mmHg. */
export interface BloodPressureReference {
  systolic: number;
  diastolic: number;
}

export interface VitalsHistoryRepository {
  /**
   * EN-269, EN-270. The takings, newest first, bounded; never those of an
   * annulled attention.
   */
  takings(query: VitalsHistoryQuery): Promise<VitalsTaking[]>;
  /** EN-269. How many there are in all, with the SAME predicate as the list. */
  countTakings(query: Omit<VitalsHistoryQuery, 'limit'>): Promise<number>;
  /**
   * EN-272. The pair of ONE active site in scope — the one with the lowest
   * systolic line —; `null` only when the scope holds no active site.
   */
  bloodPressureReference(
    sites: SiteScopeFilter,
  ): Promise<BloodPressureReference | null>;
  /**
   * EN-276. Whether a taking of the SAME predicate exists at a site outside
   * `sites` — only whether, never which nor how many (EN-121).
   */
  hasTakingsOutsideScope(
    query: Omit<VitalsHistoryQuery, 'limit'>,
  ): Promise<boolean>;
}

export const VITALS_HISTORY_REPOSITORY = Symbol('VitalsHistoryRepository');
