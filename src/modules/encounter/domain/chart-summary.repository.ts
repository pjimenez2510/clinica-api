/**
 * EN-159. The patient's history as it has to look DURING the consultation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ONE PORT AND NOT THREE CALLS FROM A SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious shape — list the attentions, then ask for each one's diagnoses,
 * then for each one's vital signs — is N+1 round trips for a screen that opens
 * on every single consultation. But the reason it is refused here is not
 * performance, it is §7 bis of `FLUJO-DE-LA-ATENCION.md`: the documented
 * problem with clinical histories **is not missing data, it is fragmentation**,
 * and fragmented models make understanding a patient cost more effort. A read
 * model assembled by the client is fragmentation with extra steps.
 *
 * So one query answers the whole thing, and the shape below is what a
 * consultation needs — not what the tables happen to hold.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT IS DELIBERATELY *NOT* IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - NO NOTE TEXT (EN-160). Of a clinical note today, 18% was written by its
 *    author, 46% is copied and 36% imported, and each 1% of imported text adds
 *    1,5% of length. What travels here is identifiers and structured values;
 *    the note is opened through its own route, which leaves its own audit row.
 *  - NO ANTECEDENTES (EN-085). ⚠️ **Falta esquema**, and it is written down
 *    rather than approximated. Serving the `antecedentes` section of the last
 *    signed 002 would look like the requirement and be the wrong thing: a note
 *    is immutable (EN-023), so the family history discovered in March would
 *    keep reappearing exactly as it was in March and the one discovered in
 *    April would never join it. EN-085 asks for a table per patient, sibling
 *    to `patient_allergy` and with its same regime — refuted, never deleted —
 *    and until it exists this response has no field for it. An empty field
 *    would read as «no consta ninguno».
 *  - NO PRESCRIPTIONS. `prescription` owns them and no module imports another.
 *    When that module exists the summary gains them the way the allergies
 *    arrive here: through a shared port, not an import.
 */

import type {
  CareModality,
  CareSetting,
  DiagnosisCertainty,
  DischargeCondition,
  EncounterStatus,
  VisitSequence,
} from './encounter';
import type { SiteScopeFilter } from './encounter.repository';

/**
 * EN-159. Which chart, how much of it, and seen by whom.
 */
export interface ChartSummaryQuery {
  /**
   * The chart. The adapter resolves it AND the charts it absorbed (PA-055) —
   * this is the read where a bare identifier costs an allergy.
   */
  patientId: string;
  /** EN-121. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  /**
   * The attention being conducted, left OUT of «anteriores».
   *
   * Absent when the summary is asked for outside any attention. Present, the
   * doctor does not get today's consultation listed as its own history, which
   * is the sort of noise that makes people stop reading a panel.
   */
  excludeEncounterId?: string;
  /**
   * How many previous attentions come back. NOT A PAGE — a bound.
   *
   * §7 bis is the argument: a compact view ordered by clinical relevance, not
   * a dump. The whole history stays one call away at
   * `GET /encounters?patientId=`, which is the listing EN-015 already serves.
   */
  limit: number;
}

/** EN-159. One previous attention, in the ten facts a consultation uses. */
export interface PreviousEncounterSummary {
  id: string;
  siteId: string;
  startedAt: Date;
  status: EncounterStatus;
  careModality: CareModality;
  careSetting: CareSetting;
  visitSequence: VisitSequence;
  dischargeCondition: DischargeCondition | null;
  /**
   * EN-159. The diagnoses, principal first.
   *
   * ⚠️ THE CODE AND THE DESCRIPTION AS THEY WERE FROZEN (EN-041), never as the
   * catalogue reads them today. In fifteen years the catalogue may have been
   * migrated or reloaded and the summary still has to say what was diagnosed.
   */
  diagnoses: readonly SummaryDiagnosis[];
  /**
   * EN-068, EN-159. Block D of that attention, or `null` when nobody took it.
   *
   * FIRST OF THE FOUR THINGS CLINICIANS SAID THEY MISSED, in the order §7 bis
   * records them: constantes vitales, ECG, informes de alta previos,
   * laboratorio previo. Of the four this system holds exactly this one today;
   * the rest arrive with `orders` and the certificates. A weight on its own
   * says nothing — a weight four kilos lower than two months ago says a lot,
   * which is the whole of why the previous ones travel with the current one.
   */
  vitals: SummaryVitals | null;
}

/** EN-041, EN-043. One diagnosis, as frozen on the day it was made. */
export interface SummaryDiagnosis {
  cie10Code: string;
  cie10Display: string;
  certainty: DiagnosisCertainty;
  /** EN-043. 1 is the principal, and an attention has at most one. */
  rank: number;
}

/**
 * EN-068. The measurements a consultation actually looks back at.
 *
 * ⚠️ A SUBSET OF `VitalSignsView`, ON PURPOSE, BY EN-160's SAME ARGUMENT: the
 * head and abdominal circumferences, the respiratory rate and the oxygen
 * saturation are in the record and are read through `GET
 * /encounters/:id/vitals`, which is one click away. Ten numbers per row over
 * five rows is a dump; five is a trend somebody can see.
 */
export interface SummaryVitals {
  weightKg: number | null;
  heightCm: number | null;
  /** EN-061. The figure `trg_encounter_vitals_bmi` wrote, never a derived one. */
  bmi: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  temperatureC: number | null;
  measuredAt: Date;
}

/** EN-159. The read model described at the top of this file: one statement, no note text. */
export interface ChartSummaryRepository {
  /**
   * EN-159. The chart's previous attentions, newest first, in ONE statement.
   *
   * ⚠️ THROUGH `chartScope` AND NEVER THROUGH `patientId`. When two charts of
   * the same person are merged, a read by the bare identifier returns half a
   * clinical history AND NEITHER FAILS NOR WARNS — it simply omits. In a
   * consultation that is an allergy that does not appear, and it is the exact
   * shape of defect PA-009. `patient-chart-scope.spec.ts` walks this module's
   * adapter and breaks the build over it.
   *
   * NEWEST FIRST, like `historyOf`: what a clinician opens is the last
   * attention, and a summary that started at the oldest would need scrolling
   * to reach what happened last month.
   */
  previousEncounters(
    query: ChartSummaryQuery,
  ): Promise<PreviousEncounterSummary[]>;

  /**
   * EN-159. How many attentions the chart has in total, for the caller's
   * scope.
   *
   * SERVED BESIDE THE BOUNDED LIST so a screen can say «5 de 23» rather than
   * implying the patient has been seen five times. A truncation the reader
   * cannot see is worse than no truncation: it is a history that quietly looks
   * shorter than it is.
   */
  countEncounters(query: ChartSummaryQuery): Promise<number>;
}

/** Injection token. The application never names the adapter. */
export const CHART_SUMMARY_REPOSITORY = Symbol('ChartSummaryRepository');
