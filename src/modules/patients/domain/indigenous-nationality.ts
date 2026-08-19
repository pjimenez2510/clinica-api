/**
 * When the RDACAA's «nacionalidad o pueblo indígena» may be recorded at all
 * (PA-027, REQ-022, D-036).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE IS THE MINISTRY'S FORM, NOT OURS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In the RDACAA the «Nacionalidad» field is ENABLED ONLY IF the ethnic
 * self-identification is «Indígena», and it collects Kichwa, Shuar, Awa… A
 * chart that says «Mestizo/a» and at the same time declares a Kichwa people is
 * a contradiction the ministry does not expect, and nothing downstream would
 * fail loudly: it comes back in the monthly report months later.
 *
 * ⚠️ THE SOURCE IS A THIRD-PARTY COPY. The condition comes from the user manual
 * of the RDACAA v2.0 software; the MSP's own instructivo has not been obtained
 * from an official source (D-036, still open). It may therefore turn out to be
 * something else, which is precisely why the whole rule is THIS FILE and the
 * constant below is the only thing that has to change.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A `CHECK`, WHICH IS WHERE THE REST OF THIS MODULE LIVES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The cedula check digit, a death before a birth and a chart that is its own
 * mother are all `CHECK`s, and this one cannot be: whether an ethnicity is
 * «Indígena» depends on WHICH ROW of the `ETHNICITY` catalogue it points at,
 * and that is another table — a `CHECK` cannot query one. Same reason PA-053
 * resolves the country against the catalogue in the service and leaves only the
 * three-letter shape to the database. Nobody should look for this guarantee in
 * the schema, and nobody should assume the database holds it.
 */

/**
 * The `ETHNICITY` code that means «Indígena». THE ONLY PLACE THAT DECIDES IT.
 *
 * ⚠️ BY CODE, NEVER BY DISPLAY TEXT. The list is a catalogue: INEC rewords its
 * categories between censuses and every chart keeps the wording it was recorded
 * with (PA-026), so comparing against «Indígena» as a string is a rule that
 * stops holding without anything failing. `prisma/seed-rdacaa.mts` loads the
 * eight categories with the codes of question 11 of the INEC 2022 census, and
 * there «Indígena» is the `1`.
 *
 * ⚠️ IF THE RDACAA INSTRUCTIVO CHANGES THE LIST, THIS LINE IS THE ONLY THING TO
 * TOUCH — plus the seed release that loads the new codes. Any comparison
 * spread elsewhere in the code would be a second place to remember.
 */
export const INDIGENOUS_ETHNICITY_CODE = '1';

/**
 * A chart as this rule sees it: what it identifies as, and whether it declares
 * a nationality.
 *
 * THE ETHNICITY ARRIVES AS ITS CATALOGUE CODE AND THE NATIONALITY AS AN ID, and
 * the asymmetry is the point: this file has to know WHICH ethnicity it is, and
 * has to know nothing at all about which nationality — any of the 34 is
 * admissible, or none.
 */
export interface NationalityDeclaration {
  /**
   * The `code` of the chart's `ETHNICITY` concept, `null` when it has none.
   *
   * Resolved WITHOUT asking whether the concept is still in force: a category
   * INEC withdraws does not stop being the one the patient declared.
   */
  ethnicityCode: string | null;
  nationalityConceptId: string | null;
}

/** Whether an ethnicity code is the one the RDACAA enables the field for. */
export function isIndigenousEthnicity(ethnicityCode: string | null): boolean {
  return ethnicityCode === INDIGENOUS_ETHNICITY_CODE;
}

/**
 * Whether the chart may NOT hold the nationality it declares (PA-027).
 *
 * A MISSING ETHNICITY COUNTS AS «not indigenous», and that is a decision: the
 * form enables the field only on an affirmative answer, so a nationality on a
 * chart whose ethnicity nobody has asked for yet is a datum the report cannot
 * place. The chart is left saying what it is missing (PA-032) instead.
 *
 * No nationality, no rule: the field is optional at registration (D-028) and
 * an ethnicity of any kind on its own is a perfectly ordinary chart.
 */
export function nationalityContradictsEthnicity(
  chart: NationalityDeclaration,
): boolean {
  if (chart.nationalityConceptId === null) return false;
  return !isIndigenousEthnicity(chart.ethnicityCode);
}
