import type { SubstanceKeys } from './allergy-match';

/**
 * AS-064, AS-069, AS-072, AS-074. What the assistant reads to propose a
 * receta, for a module that does not own `prescription` nor the CNMB.
 *
 * The attention, its note and the names to clear come from
 * `CodingContextReader`; the allergies from `SurvivingChartAllergyReader` —
 * the same statement the receta checks with (PR-062, PR-118). This port is
 * only what is particular to the receta: the cuadro, the substance keys the
 * allergy rule compares, and what the attention already prescribes.
 *
 * ⚠️ IT READS AND IT NEVER WRITES. A draft is written by `prescription`
 * through its own route, with its checks and its `If-Match` (PR-100, PR-121);
 * the assistant never composes, rewrites or issues one (P1, AS-073).
 */

/** PR-115. One presentation the cuadro declares for a medicine. */
export interface CnmbPresentation {
  /** The vocabulary form a choice of it proposes (`TABLET`). */
  form: string;
  /** Every vocabulary form it admits; absent, only `form`. */
  forms?: readonly string[];
  /** As the cuadro writes it: `500 mg`, `250 mg/5 mL`, `1 mg - 5 mg`. */
  concentration: string;
  /** The form as the cuadro names it («Sólido oral»). */
  label?: string;
  /** The cuadro's route (`O - Oral`). */
  route?: string;
}

/** AS-064. A medicine of the cuadro in force, with what it is offered as. */
export interface CnmbMedicine {
  conceptId: string;
  /** The ATC code the cuadro files it under (`J01CA04`). */
  code: string;
  /** The DCI as the cuadro writes it: what the screen shows (AS-064). */
  display: string;
  presentations: CnmbPresentation[];
  /** PR-070, PR-116. Its receta is the ACESS's, not this system's. */
  controlled: boolean;
}

/** AS-074. One saved line of a receta, in the codes it was written with. */
export interface PrescribedLine {
  conceptId: string | null;
  dosageFormCode: string | null;
  concentration: string | null;
  routeCode: string | null;
  doseAmount: number | null;
  doseUnitCode: string | null;
  frequencyCode: string | null;
  frequencyText: string;
  durationDays: number | null;
  quantity: number | null;
}

export interface PrescribingContextReader {
  /**
   * AS-064. Up to `limit` medicines of the CNMB in force on `clinicalDate`
   * whose DCI or name contains `name` (no accents, no case), the exact name
   * first. An empty or blank name finds nothing.
   */
  searchCnmb(
    name: string,
    clinicalDate: string,
    limit: number,
  ): Promise<CnmbMedicine[]>;

  /**
   * AS-069, PR-114. The keys of each concept named — code, codes replaced,
   * active substances — read exactly as the issue reads them.
   */
  substanceKeys(conceptIds: readonly string[]): Promise<SubstanceKeys>;

  /**
   * AS-072. The CNMB codes this attention already prescribes, in any receta
   * that was not discarded nor annulled. Codes, not ids: an edition of the
   * cuadro loaded since makes a new id for the same medicine.
   */
  prescribedCodes(encounterId: string): Promise<string[]>;

  /**
   * AS-074. Line `line` (1-based, the receta's own order) of `prescriptionId`
   * when that receta is of THIS attention and not discarded; null otherwise.
   */
  prescriptionLine(
    encounterId: string,
    prescriptionId: string,
    line: number,
  ): Promise<PrescribedLine | null>;
}

export const PRESCRIBING_CONTEXT_READER = Symbol('PRESCRIBING_CONTEXT_READER');
