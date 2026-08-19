/**
 * When the RDACAA's indigenous nationality may be recorded at all
 * (PA-027, REQ-022, D-036).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE IS THE MINISTRY'S FORM, NOT OURS, AND ITS OWN INSTRUCTIVO SAYS SO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Column 13 of the RDACAA form, «Nacionalidades», is the INDIGENOUS
 * nationality — Achuar, Awa, Kichwa, Shuar… — and the ministry's instructivo
 * (SNS-MSP / Form. 504 / 2019, § 1.4.13) states it «aplica únicamente para la
 * autoidentificación "indígena"». A chart that says «Mestizo/a» and at the same
 * time declares Kichwa is a contradiction the ministry does not expect, and
 * nothing downstream would fail loudly: it comes back in the monthly report
 * months later.
 *
 * ⚠️ NOT TO BE CONFUSED WITH COLUMN 11, «Nacionalidad», in the singular, which
 * is the COUNTRY OF ORIGIN and lives in `country_of_nationality_code` against
 * the `COUNTRY` catalogue (PA-053). Two columns, two lists, near-identical
 * names. This file is about column 13 only.
 *
 * The rule was first built from a third-party copy of the RDACAA v2.0 software
 * manual and the official instructivo, obtained on 19-08-2026, CONFIRMS IT
 * word for word. It stays concentrated in this file anyway: the constant below
 * is still the only thing a change to the ethnicity list would have to touch.
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
 * ⚠️ BY CODE, NEVER BY DISPLAY TEXT. The list is a catalogue: the ministry
 * rewords its categories between editions and every chart keeps the wording it
 * was recorded with (PA-026), so comparing against «Indígena» as a string is a
 * rule that stops holding without anything failing. `prisma/seed-rdacaa.mts`
 * loads the nine categories of column 12 of the instructivo, and there
 * «Indígena» is the `1` — as it was in the INEC census list it replaced, which
 * is why this constant did not move on 19-08-2026.
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
 * has to know nothing at all about which nationality — any of the 16 of column
 * 13 is admissible, or none.
 */
export interface NationalityDeclaration {
  /**
   * The `code` of the chart's `ETHNICITY` concept, `null` when it has none.
   *
   * Resolved WITHOUT asking whether the concept is still in force: a category
   * the ministry withdraws does not stop being the one the patient declared.
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
