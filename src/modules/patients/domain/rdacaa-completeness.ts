import { isIndigenousEthnicity } from './indigenous-nationality';

/**
 * Which of the data the RDACAA demands are still missing from a chart
 * (PA-032, REQ-022, D-028, D-037).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT NEVER STOPS THE CHART FROM EXISTING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-028 settled it on 16-08-2026: these fields are OPTIONAL at registration
 * and mandatory when the first encounter is closed. The norm demands them «en
 * cada consulta», not at registration, and blocking the desk at three in the
 * morning with a newborn in the room is exactly what REQ-009 forbids. Never
 * demanding them leaves the monthly report incomplete until the Dirección
 * Distrital sends it back.
 *
 * So this is an INDICATOR: it names what is missing, by field, so admission
 * can complete it without guessing. What blocks the close of the first
 * encounter belongs to `encounter` and is specified there — this is its input,
 * not its substitute.
 */

/**
 * The four, and only these four.
 *
 * ⚠️ GENDER IDENTITY IS NOT ONE OF THEM, and leaving it out is the decision.
 * REQ-022 enumerates document, sex, ethnic self-identification, nationality,
 * age and residence. Age is derived (PA-030) and sex is mandatory at
 * registration already, so what can be missing is these four. Marking a chart
 * incomplete for a datum the report does not ask for would turn the indicator
 * into noise that admission learns to ignore — and an indicator nobody reads
 * is worse than none, because it still looks like a control.
 */
export const RDACAA_REQUIRED_FIELDS = [
  'identifier',
  'ethnicityConceptId',
  'nationalityConceptId',
  'residenceParishConceptId',
] as const;

export type RdacaaRequiredField = (typeof RDACAA_REQUIRED_FIELDS)[number];

export interface RdacaaChart {
  /**
   * Whether the chart holds an active DEFINITIVE identity document.
   *
   * ⚠️ DEFINITIVE, and the word is the whole point: a `PROVISIONAL` marker is
   * not a document (see `isDefinitiveDocument`, and the predicate of
   * `patient_identifier_active_unique` it comes from). Counting one here would
   * declare the chart complete for the RDACAA with no identity document at
   * all, which is the state PA-015 exists to END, not to disguise.
   *
   * A BOOLEAN AND NOT THE IDENTIFIER ITSELF: this file must not learn what a
   * document looks like, and the caller already knows.
   */
  hasDefinitiveDocument: boolean;
  ethnicityConceptId: string | null;
  /**
   * The `code` of that same ethnicity concept, `null` when there is none.
   *
   * THE ID AND THE CODE, and both are needed for different halves of the
   * answer: the id says whether the ethnicity was ASKED AT ALL, and the code
   * says WHICH ONE it is — the only thing that decides whether the ministry
   * enables the nationality field (D-037). Deriving one from the other here is
   * not possible: which row of the `ETHNICITY` catalogue an id points at is
   * another table, and this layer reads nothing.
   *
   * ⚠️ THE CODE, NEVER THE DISPLAY TEXT, and never a second comparison of it:
   * `isIndigenousEthnicity` is the one place that decides, exactly as PA-027
   * uses it. See the header of `indigenous-nationality.ts`.
   */
  ethnicityCode: string | null;
  nationalityConceptId: string | null;
  residenceParishConceptId: string | null;
}

/**
 * Whether the RDACAA asks THIS chart for a nationality at all (PA-032, D-037).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY CONDITIONAL IN THIS FILE, AND PA-027 IS WHAT PUTS IT HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Since PA-027 enforces the ministry's form — the nationality or indigenous
 * people may be recorded ONLY on a chart that identifies as «Indígena» —
 * counting it on every chart left the majority of them permanently incomplete
 * over a box THE SYSTEM ITSELF REFUSES TO LET ANYBODY FILL IN. An indicator
 * nobody can drive to zero is one admission learns to ignore, which is the same
 * argument that kept gender identity (PA-032) and the country (PA-053) out of
 * it. D-037, resolved on 17-08-2026, option A.
 *
 * ⚠️ A MISSING ETHNICITY STILL DEMANDS IT, and that is the half that is easy to
 * lose: until somebody has asked the question, nobody knows whether the field
 * applies. Dropping it there would let a chart read as complete and then start
 * missing the nationality the moment «Indígena» is recorded — the indicator
 * would go backwards without anything changing about the report.
 */
function nationalityIsDemanded(chart: RdacaaChart): boolean {
  if (chart.ethnicityConceptId === null) return true;
  return isIndigenousEthnicity(chart.ethnicityCode);
}

/**
 * The missing fields, by name. Empty means complete.
 *
 * By NAME and not a count or a boolean: admission has to be able to fix it,
 * and «faltan 2 datos» sends somebody hunting through the form.
 */
export function rdacaaMissingFields(
  chart: RdacaaChart,
): readonly RdacaaRequiredField[] {
  /**
   * SETTLED, not «present»: three of the four are settled by being there, and
   * the nationality is also settled by not being demanded of this chart.
   */
  const settled: Record<RdacaaRequiredField, boolean> = {
    identifier: chart.hasDefinitiveDocument,
    ethnicityConceptId: chart.ethnicityConceptId !== null,
    nationalityConceptId:
      !nationalityIsDemanded(chart) || chart.nationalityConceptId !== null,
    residenceParishConceptId: chart.residenceParishConceptId !== null,
  };

  return RDACAA_REQUIRED_FIELDS.filter((field) => !settled[field]);
}
