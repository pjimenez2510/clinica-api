/**
 * PR-060 to PR-067. The one allergy check this system is entitled to make.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE LEVELS, AND ONLY THE FIRST IS OURS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **EXACT MATCH** — the active substance prescribed IS the one the chart
 *     says the patient reacts to. `patient_allergy.substance_concept_id` and
 *     `prescription_item.concept_id` both point at the CNMB, so this is a
 *     COMPARISON OF KEYS: no text, no stemming, no heuristics. Built, and it is
 *     the only one that interrupts.
 *  2. **THERAPEUTIC CLASS** — same ATC group. ⚠️ **Falta esquema** (PR-065):
 *     `catalog_concept.attributes` is meant to carry the ATC code of the CNMB
 *     and is not populated.
 *  3. **CROSS-REACTIVITY** — penicillins and cephalosporins and the rest. NOT
 *     BUILT AND NOT SIMULATED (PR-066): it is a commercial knowledge base, and
 *     an approximation of one produces warnings nobody can audit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE ALERT HAS TO BE PROPORTIONATE, WHICH IS A REQUIREMENT (PR-067)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In a study of 158 023 allergy warnings, 81 % were overridden — and on audit,
 * more than 96 % of those overrides were clinically correct. An alert that is
 * right one time in twenty does not protect anybody: it teaches the reader to
 * dismiss without looking, and the one they dismiss without looking is the
 * twentieth. So there is exactly ONE blocking alert in this module, it fires
 * almost never, and everything else informs.
 *
 * PURE: two lists in, a list of matches out. No database, no clock.
 */

/** PR-062. One allergy of the chart — and of every chart it absorbed. */
export interface KnownAllergy {
  id: string;
  /**
   * PR-064. The CNMB concept when the allergen is a drug; `null` when it is a
   * food, latex or an insect sting and only free text was recorded.
   *
   * ⚠️ A `null` HERE CAN NEVER MATCH, and that is the design rather than a
   * limitation: level 1 compares keys. Comparing the free text is precisely how
   * false alerts are manufactured — «penicilina» does not match «amoxicilina»,
   * and «polvo» matches «polvo para suspensión oral».
   */
  substanceConceptId: string | null;
  /** What the chart says, for the document (PR-027). Never for matching. */
  substanceText: string;
}

/** One line of the prescription, as the check sees it. */
export interface PrescribedSubstance {
  /** 1-based, because it is what an error message names (PR-032, PR-094). */
  line: number;
  conceptId: string | null;
}

/** PR-060, PR-067. One exact coincidence, addressed by line and by allergy. */
export interface AllergyAlert {
  line: number;
  allergyId: string;
  /**
   * ⚠️ NO MEDICATION NAME AND NO SUBSTANCE TEXT. The alert travels to the
   * client, and from there to logs and support screenshots; a drug name IS a
   * diagnosis said differently — metformin says diabetes, efavirenz says HIV
   * (PR-094, SC-036). The screen already holds the line it is about, and the
   * allergy is addressed by its identifier so the doctor can open it.
   */
  match: 'EXACT';
}

/**
 * PR-060, PR-063, PR-064. Every exact coincidence between what is prescribed
 * and what the chart flags.
 *
 * REFUTED ALLERGIES DO NOT REACH HERE (PR-063): the adapter filters
 * `refuted_at IS NULL` in the same statement that reads them, so «se descartó»
 * is a property of the query rather than a condition somebody has to remember
 * at each call site. Knowing an allergy was ruled out is clinical information
 * in its own right — which is why the row survives — and it is not a
 * contraindication.
 *
 * ONE ALERT PER (LINE, ALLERGY) PAIR: the same substance recorded twice on two
 * merged charts produces two alerts, and collapsing them would hide that the
 * evidence comes from two places.
 */
export function exactAllergyMatches(
  items: readonly PrescribedSubstance[],
  allergies: readonly KnownAllergy[],
): AllergyAlert[] {
  const alerts: AllergyAlert[] = [];

  for (const item of items) {
    if (item.conceptId === null) continue;
    for (const allergy of allergies) {
      if (allergy.substanceConceptId === null) continue;
      if (allergy.substanceConceptId !== item.conceptId) continue;
      alerts.push({ line: item.line, allergyId: allergy.id, match: 'EXACT' });
    }
  }

  return alerts;
}
