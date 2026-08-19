/**
 * When the RDACAA's ethnic self-identification may be recorded at all
 * (PA-059, REQ-022, D-039 (c)).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STEP ABOVE THE CHAIN, AND THE INSTRUCTIVO WRITES IT TWICE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Over column 12 the ministry's instructivo (SNS-MSP / Form. 504 / 2019,
 * § 1.4.12) notes «Aplica para nacionalidad Ecuatoriana», and over column 11
 * it repeats the same rule from the other side: «Si el usuario NO es
 * ecuatoriano, pase a la columna 15 dejando los espacios en blanco». Column 15
 * is the residence, so what the ministry means is that columns 12, 13 and 14 —
 * ethnicity, indigenous nationality and people — stay blank for a foreign
 * patient.
 *
 * ONLY THE ETHNICITY IS CHECKED HERE, and the other two fall out on their own:
 * PA-027 refuses a nationality without an indigenous ethnicity, and PA-056
 * refuses a people without a Kichwa nationality. Repeating the country test on
 * each of the three would be three places to keep in step.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A `CHECK`, AND THE REASON DIFFERS FROM THE OTHER TWO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PA-027 and PA-056 cannot be `CHECK`s because they depend on another table.
 * This one does not: both columns live on `patient`, so a `CHECK` COULD
 * compare them — as long as it wrote the literal `'ECU'`. That is the whole
 * argument against it: the constant below would then exist twice, in SQL and
 * in TypeScript, and two copies of a literal are two things that one day
 * disagree with nothing failing. It stays where the other two steps of the
 * chain are, in the service, with one place that knows what Ecuador is.
 *
 * The consequence is the same as theirs and is accepted: an import or a `psql`
 * INSERT can write the contradiction, and what would catch it is the monthly
 * report.
 */

/**
 * The `ISO 3166-1 alpha-3` code of Ecuador. THE ONLY PLACE THAT DECIDES IT.
 *
 * ⚠️ THE CODE, NEVER THE NAME. `patient.country_of_nationality_code` stores
 * three letters — exactly like `patient_identifier.issuing_country` — and the
 * name is resolved from the `COUNTRY` catalogue only when a chart is opened
 * (PA-053). A rule comparing «Ecuador» as a string would break the day the
 * catalogue reworded it, and the chart would silently stop being Ecuadorian.
 */
export const ECUADOR_COUNTRY_CODE = 'ECU';

/**
 * A chart as this rule sees it: which country it declares, and whether it
 * declares an ethnicity.
 */
export interface EthnicityDeclaration {
  /** `ISO 3166-1 alpha-3`, already upper-cased, or `null` when unrecorded. */
  countryOfNationalityCode: string | null;
  ethnicityConceptId: string | null;
}

/**
 * Whether the RDACAA lets THIS chart carry columns 12 to 14 at all.
 *
 * ⚠️ A MISSING COUNTRY MEANS YES, and that is the decision this file turns on.
 * The country is optional (PA-053) and most charts carry none, so reading
 * «unrecorded» as «not Ecuadorian» would make the ethnicity unrecordable for
 * almost every patient in the register — the opposite of what column 12 is
 * for. It is the mirror image of PA-027's missing-ethnicity branch: there the
 * conditional field is refused while the question is unanswered; here the
 * conditional field IS the question, and the answer is allowed.
 *
 * Shared with `rdacaa-completeness.ts`, which needs the same predicate to stop
 * demanding what this rule forbids (PA-059, and the argument of D-037).
 */
export function ethnicityApplies(
  countryOfNationalityCode: string | null,
): boolean {
  if (countryOfNationalityCode === null) return true;
  return countryOfNationalityCode === ECUADOR_COUNTRY_CODE;
}

/**
 * Whether the chart may NOT hold the ethnicity it declares (PA-059).
 *
 * No ethnicity, no rule: registering a foreign patient with no ethnicity is
 * exactly what the ministry asks for.
 */
export function ethnicityContradictsCountry(
  chart: EthnicityDeclaration,
): boolean {
  if (chart.ethnicityConceptId === null) return false;
  return !ethnicityApplies(chart.countryOfNationalityCode);
}
