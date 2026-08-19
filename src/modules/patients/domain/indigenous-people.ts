/**
 * When the RDACAA's people may be recorded at all (PA-056, REQ-022, D-039).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THIRD STEP OF A CHAIN WHOSE FIRST TWO ARE ALREADY BUILT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ethnicity → indigenous nationality → people, each one enabled by the answer
 * to the one before it. `indigenous-nationality.ts` is the step above and this
 * file is its twin one column further along: same shape, same argument, same
 * failure mode if it is got wrong. Read that header first — everything it says
 * about codes, catalogues and `CHECK`s is true here word for word.
 *
 * Column 14 of the RDACAA form, «Pueblos», carries 18 codes — Chibuleo,
 * Karanki, Otavalo, Saraguro… — and the ministry's instructivo (SNS-MSP /
 * Form. 504 / 2019, § 1.4.14) states it «Aplica únicamente para la
 * nacionalidad indígena "Kichwa"». A chart that says Shuar and at the same
 * time declares Otavalo is a contradiction the ministry does not expect, and
 * nothing downstream would fail loudly: it comes back in the monthly report
 * months later.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A `CHECK`, WHICH IS WHERE THE REST OF THIS MODULE LIVES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Whether a nationality is «Kichwa» depends on WHICH ROW of the `NATIONALITY`
 * catalogue it points at, and that is another table — a `CHECK` cannot query
 * one. Exactly the reason PA-027 gives, and PA-053 for the country. Nobody
 * should look for this guarantee in the schema, and nobody should assume the
 * database holds it: an import or a `psql` INSERT can write the contradiction,
 * and what would catch it is the monthly report.
 */

/**
 * The `NATIONALITY` code that means «Kichwa». THE ONLY PLACE THAT DECIDES IT.
 *
 * ⚠️ BY CODE, NEVER BY DISPLAY TEXT, and this one has already moved. In the
 * instructivo's column 13 Kichwa is the `6`; in the INEC-derived list this
 * catalogue held until 19-08-2026 it was the `14` — which in the ministry's
 * list is Andoa. A rule comparing «Kichwa» as a string, or one holding the old
 * number, would stop being true with nothing failing, and the symptom would be
 * a chart recorded against the wrong people.
 *
 * ⚠️ IF THE INSTRUCTIVO CHANGES THE LIST, THIS LINE IS THE ONLY THING TO TOUCH
 * — plus the seed release that loads the new codes.
 */
export const KICHWA_NATIONALITY_CODE = '6';

/**
 * A chart as this rule sees it: which nationality it declares, and whether it
 * declares a people.
 *
 * THE NATIONALITY ARRIVES AS ITS CATALOGUE CODE AND THE PEOPLE AS AN ID, and
 * the asymmetry is the point: this file has to know WHICH nationality it is,
 * and has to know nothing at all about which people — any of the 18 of column
 * 14 is admissible, or none.
 */
export interface PeopleDeclaration {
  /**
   * The `code` of the chart's `NATIONALITY` concept, `null` when it has none.
   *
   * Resolved WITHOUT asking whether the concept is still in force: a category
   * the ministry withdraws does not stop being the one the patient declared.
   */
  nationalityCode: string | null;
  peopleConceptId: string | null;
}

/** Whether a nationality code is the one the RDACAA enables column 14 for. */
export function isKichwaNationality(nationalityCode: string | null): boolean {
  return nationalityCode === KICHWA_NATIONALITY_CODE;
}

/**
 * Whether the chart may NOT hold the people it declares (PA-056).
 *
 * A MISSING NATIONALITY COUNTS AS «not Kichwa», and that is the same decision
 * PA-027 makes one step up: the form enables the field only on an affirmative
 * answer, so a people on a chart whose nationality nobody has asked for yet is
 * a datum the report cannot place.
 *
 * No people, no rule: the field is optional at registration (D-028) and a
 * nationality of any kind on its own is a perfectly ordinary chart.
 */
export function peopleContradictsNationality(
  chart: PeopleDeclaration,
): boolean {
  if (chart.peopleConceptId === null) return false;
  return !isKichwaNationality(chart.nationalityCode);
}
