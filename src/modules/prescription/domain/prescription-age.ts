/**
 * PR-025. «Edad. Para el caso de menores de cinco (5) años, la edad se
 * especificará en años y meses» — art. 5.b.ii.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY MONTHS ONLY UNDER FIVE, AND WHY IT IS NOT A COURTESY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Almost every paediatric dose is milligrams per kilogram, and the weight of a
 * child is a function of the month, not of the year: «2 años» covers a range in
 * which the correct dose of the same syrup nearly doubles. The norm asks for
 * months where the number changes the medicine, and asks for years where it
 * does not.
 *
 * ⚠️ AND IT IS THE FROZEN AGE OF THE ATTENTION, NEVER TODAY'S. `age_years`,
 * `age_months` and `age_days` are written once by `trg_encounter_freeze_age`
 * out of `patient.birth_date` — which is `NOT NULL` — and never recomputed. A
 * prescription filed five years ago has to keep saying the age the child had
 * that day: derive it and correcting a mistyped birth date silently rewrites
 * documents already handed to a pharmacy. Same reasoning as EN-008.
 *
 * PURE: the age arrives as three numbers. No clock reaches this file, which is
 * the only way «cuatro años once meses» can be exercised without waiting.
 */

/** PR-025. The threshold art. 5.b.ii draws. */
export const MONTHS_REQUIRED_BELOW_YEARS = 5;

/** The three columns of `encounter`, as storage hands them over. */
export interface FrozenAge {
  years: number | null;
  months: number | null;
  days: number | null;
}

/** PR-025. The age as the prescription prints it. */
export interface PrescriptionAge {
  years: number;
  /** Present exactly when the patient is under five (art. 5.b.ii). */
  months: number | null;
  /** The sentence the document carries: «1 año 2 meses», «34 años». */
  text: string;
}

/** `1 año`, `34 años`: the figure followed by the singular or plural word. */
const plural = (value: number, one: string, many: string): string =>
  `${value} ${value === 1 ? one : many}`;

/**
 * PR-025. The age of the patient, in the form the norm demands.
 *
 * `null` when the attention carries no frozen age. That cannot happen for a row
 * this system wrote — the trigger fills the three columns on every `INSERT` —
 * and it is still modelled rather than defaulted to zero: a prescription that
 * printed «0 años» for a missing age would be a document asserting something
 * nobody recorded, which is worse than a document with a gap somebody notices.
 */
export function prescriptionAgeOf(age: FrozenAge): PrescriptionAge | null {
  if (age.years === null) return null;

  if (age.years >= MONTHS_REQUIRED_BELOW_YEARS) {
    return {
      years: age.years,
      months: null,
      text: plural(age.years, 'año', 'años'),
    };
  }

  const months = age.months ?? 0;
  // Under one year the years half says nothing a pharmacist can use, so the
  // sentence drops it: «2 meses», not «0 años 2 meses».
  const text =
    age.years === 0
      ? plural(months, 'mes', 'meses')
      : `${plural(age.years, 'año', 'años')} ${plural(months, 'mes', 'meses')}`;

  return { years: age.years, months, text };
}
